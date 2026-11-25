// The daemon's only door to the macOS Keychain: four calls on generic password items.
//
// Every call returns a promise and does its Security framework work in Node-API async work,
// on a libuv pool thread. A Keychain call is a round trip to the system's security service
// that can be slow, and macOS may decide to show a prompt while one is in flight, so none of
// it may run on the daemon's event loop.
//
// A value never leaves this file in an error. A failure rejects with fixed text and, for a
// Security failure, the OSStatus as `status`. The buffer that held a value is overwritten
// before it is freed.

#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>
#include <node_api.h>

#include <cstddef>
#include <new>
#include <string>
#include <vector>

namespace {

constexpr size_t kMaxNameBytes = 512;
constexpr size_t kMaxValueBytes = 256 * 1024;

enum class Operation { kGet, kSet, kRemove, kAccounts };

const char* OperationName(Operation operation) {
  switch (operation) {
    case Operation::kGet:
      return "get";
    case Operation::kSet:
      return "set";
    case Operation::kRemove:
      return "remove";
    case Operation::kAccounts:
      return "accounts";
  }
  return "call";
}

void Wipe(std::string& text) {
  volatile char* bytes = text.empty() ? nullptr : &text[0];
  for (size_t i = 0; i < text.size(); i++) bytes[i] = 0;
  text.clear();
}

struct Call {
  explicit Call(Operation op) : operation(op) {}
  ~Call() {
    Wipe(value);
    Wipe(found_value);
  }

  Operation operation;
  napi_deferred deferred = nullptr;
  napi_async_work work = nullptr;
  std::string service;
  std::string account;
  std::string value;
  std::string label;

  OSStatus status = errSecSuccess;
  bool found = false;
  std::string found_value;
  std::vector<std::string> accounts;
};

/** Owns one Core Foundation reference. */
template <typename T>
class Owned {
 public:
  explicit Owned(T ref = nullptr) : ref_(ref) {}
  ~Owned() {
    if (ref_ != nullptr) CFRelease(ref_);
  }
  Owned(const Owned&) = delete;
  Owned& operator=(const Owned&) = delete;
  T get() const { return ref_; }
  T* out() { return &ref_; }

 private:
  T ref_;
};

CFStringRef CreateString(const std::string& text) {
  return CFStringCreateWithBytes(kCFAllocatorDefault,
                                 reinterpret_cast<const UInt8*>(text.data()),
                                 static_cast<CFIndex>(text.size()),
                                 kCFStringEncodingUTF8,
                                 false);
}

bool CopyString(CFStringRef text, std::string* out) {
  const CFIndex length = CFStringGetLength(text);
  const CFIndex capacity = CFStringGetMaximumSizeForEncoding(length, kCFStringEncodingUTF8) + 1;
  std::vector<char> buffer(static_cast<size_t>(capacity));
  if (!CFStringGetCString(text, buffer.data(), capacity, kCFStringEncodingUTF8)) return false;
  out->assign(buffer.data());
  return true;
}

/**
 * The query every call starts from: one generic password, by service and (optionally)
 * account. Not synchronizable, so iCloud Keychain never holds it, and no data protection
 * keychain, so the item lives in the login Keychain.
 */
CFMutableDictionaryRef CreateQuery(const std::string& service, const std::string* account) {
  CFMutableDictionaryRef query = CFDictionaryCreateMutable(
      kCFAllocatorDefault, 0, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
  if (query == nullptr) return nullptr;
  Owned<CFStringRef> service_ref(CreateString(service));
  if (service_ref.get() == nullptr) {
    CFRelease(query);
    return nullptr;
  }
  CFDictionarySetValue(query, kSecClass, kSecClassGenericPassword);
  CFDictionarySetValue(query, kSecAttrService, service_ref.get());
  CFDictionarySetValue(query, kSecAttrSynchronizable, kCFBooleanFalse);
  if (account != nullptr) {
    Owned<CFStringRef> account_ref(CreateString(*account));
    if (account_ref.get() == nullptr) {
      CFRelease(query);
      return nullptr;
    }
    CFDictionarySetValue(query, kSecAttrAccount, account_ref.get());
  }
  return query;
}

void RunGet(Call* call) {
  Owned<CFMutableDictionaryRef> query(CreateQuery(call->service, &call->account));
  if (query.get() == nullptr) {
    call->status = errSecAllocate;
    return;
  }
  CFDictionarySetValue(query.get(), kSecReturnData, kCFBooleanTrue);
  CFDictionarySetValue(query.get(), kSecMatchLimit, kSecMatchLimitOne);

  Owned<CFTypeRef> result;
  const OSStatus status = SecItemCopyMatching(query.get(), result.out());
  if (status == errSecItemNotFound) return;
  if (status != errSecSuccess) {
    call->status = status;
    return;
  }
  if (result.get() == nullptr || CFGetTypeID(result.get()) != CFDataGetTypeID()) {
    call->status = errSecInternalError;
    return;
  }
  const auto data = static_cast<CFDataRef>(result.get());
  call->found_value.assign(reinterpret_cast<const char*>(CFDataGetBytePtr(data)),
                           static_cast<size_t>(CFDataGetLength(data)));
  call->found = true;
}

void RunSet(Call* call) {
  Owned<CFMutableDictionaryRef> query(CreateQuery(call->service, &call->account));
  // No copy of the value: the bytes stay in `call`, which outlives this function and wipes
  // them when it is freed.
  Owned<CFDataRef> data(CFDataCreateWithBytesNoCopy(
      kCFAllocatorDefault,
      reinterpret_cast<const UInt8*>(call->value.data()),
      static_cast<CFIndex>(call->value.size()),
      kCFAllocatorNull));
  Owned<CFStringRef> label(CreateString(call->label));
  Owned<CFMutableDictionaryRef> changes(CFDictionaryCreateMutable(
      kCFAllocatorDefault, 0, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks));
  if (query.get() == nullptr || data.get() == nullptr || label.get() == nullptr ||
      changes.get() == nullptr) {
    call->status = errSecAllocate;
    return;
  }
  CFDictionarySetValue(changes.get(), kSecValueData, data.get());
  CFDictionarySetValue(changes.get(), kSecAttrLabel, label.get());

  OSStatus status = SecItemUpdate(query.get(), changes.get());
  if (status == errSecItemNotFound) {
    Owned<CFMutableDictionaryRef> item(
        CFDictionaryCreateMutableCopy(kCFAllocatorDefault, 0, query.get()));
    if (item.get() == nullptr) {
      call->status = errSecAllocate;
      return;
    }
    CFDictionarySetValue(item.get(), kSecValueData, data.get());
    CFDictionarySetValue(item.get(), kSecAttrLabel, label.get());
    status = SecItemAdd(item.get(), nullptr);
    // Another writer added the same item between the update and the add.
    if (status == errSecDuplicateItem) status = SecItemUpdate(query.get(), changes.get());
  }
  call->status = status;
}

void RunRemove(Call* call) {
  Owned<CFMutableDictionaryRef> query(CreateQuery(call->service, &call->account));
  if (query.get() == nullptr) {
    call->status = errSecAllocate;
    return;
  }
  const OSStatus status = SecItemDelete(query.get());
  if (status == errSecItemNotFound) return;
  call->status = status;
  call->found = status == errSecSuccess;
}

void RunAccounts(Call* call) {
  Owned<CFMutableDictionaryRef> query(CreateQuery(call->service, nullptr));
  if (query.get() == nullptr) {
    call->status = errSecAllocate;
    return;
  }
  // Attributes only: an item's data is never read to list it.
  CFDictionarySetValue(query.get(), kSecReturnAttributes, kCFBooleanTrue);
  CFDictionarySetValue(query.get(), kSecMatchLimit, kSecMatchLimitAll);

  Owned<CFTypeRef> result;
  const OSStatus status = SecItemCopyMatching(query.get(), result.out());
  if (status == errSecItemNotFound) return;
  if (status != errSecSuccess) {
    call->status = status;
    return;
  }
  if (result.get() == nullptr || CFGetTypeID(result.get()) != CFArrayGetTypeID()) {
    call->status = errSecInternalError;
    return;
  }
  const auto items = static_cast<CFArrayRef>(result.get());
  const CFIndex count = CFArrayGetCount(items);
  for (CFIndex i = 0; i < count; i++) {
    const void* entry = CFArrayGetValueAtIndex(items, i);
    if (entry == nullptr || CFGetTypeID(entry) != CFDictionaryGetTypeID()) continue;
    const void* account =
        CFDictionaryGetValue(static_cast<CFDictionaryRef>(entry), kSecAttrAccount);
    if (account == nullptr || CFGetTypeID(account) != CFStringGetTypeID()) continue;
    std::string text;
    if (CopyString(static_cast<CFStringRef>(account), &text)) call->accounts.push_back(text);
  }
}

void Execute(napi_env, void* data) {
  auto* call = static_cast<Call*>(data);
  switch (call->operation) {
    case Operation::kGet:
      RunGet(call);
      break;
    case Operation::kSet:
      RunSet(call);
      break;
    case Operation::kRemove:
      RunRemove(call);
      break;
    case Operation::kAccounts:
      RunAccounts(call);
      break;
  }
}

napi_value MakeError(napi_env env, const std::string& message) {
  napi_value text;
  napi_value error;
  if (napi_create_string_utf8(env, message.c_str(), NAPI_AUTO_LENGTH, &text) != napi_ok ||
      napi_create_error(env, nullptr, text, &error) != napi_ok) {
    return nullptr;
  }
  return error;
}

void Reject(napi_env env, napi_deferred deferred, napi_value error) {
  if (error == nullptr) {
    napi_get_undefined(env, &error);
  }
  napi_reject_deferred(env, deferred, error);
}

napi_value StatusError(napi_env env, Operation operation, OSStatus status) {
  napi_value error = MakeError(env, std::string("Keychain ") + OperationName(operation) +
                                        " failed with status " +
                                        std::to_string(static_cast<int32_t>(status)));
  if (error == nullptr) return nullptr;
  napi_value code;
  if (napi_create_int32(env, static_cast<int32_t>(status), &code) == napi_ok) {
    napi_set_named_property(env, error, "status", code);
  }
  return error;
}

napi_value Result(napi_env env, Call* call) {
  napi_value result = nullptr;
  switch (call->operation) {
    case Operation::kGet:
      if (!call->found) {
        napi_get_null(env, &result);
      } else if (napi_create_string_utf8(env, call->found_value.data(), call->found_value.size(),
                                         &result) != napi_ok) {
        result = nullptr;
      }
      break;
    case Operation::kSet:
      napi_get_undefined(env, &result);
      break;
    case Operation::kRemove:
      napi_get_boolean(env, call->found, &result);
      break;
    case Operation::kAccounts:
      if (napi_create_array_with_length(env, call->accounts.size(), &result) != napi_ok) {
        return nullptr;
      }
      for (size_t i = 0; i < call->accounts.size(); i++) {
        napi_value account;
        if (napi_create_string_utf8(env, call->accounts[i].data(), call->accounts[i].size(),
                                    &account) != napi_ok ||
            napi_set_element(env, result, static_cast<uint32_t>(i), account) != napi_ok) {
          return nullptr;
        }
      }
      break;
  }
  return result;
}

void Complete(napi_env env, napi_status status, void* data) {
  auto* call = static_cast<Call*>(data);
  if (status != napi_ok) {
    Reject(env, call->deferred,
           MakeError(env, std::string("Keychain ") + OperationName(call->operation) +
                              " was cancelled"));
  } else if (call->status != errSecSuccess) {
    Reject(env, call->deferred, StatusError(env, call->operation, call->status));
  } else {
    napi_value result = Result(env, call);
    if (result == nullptr) {
      Reject(env, call->deferred,
             MakeError(env, std::string("Keychain ") + OperationName(call->operation) +
                                " result could not be returned"));
    } else {
      napi_resolve_deferred(env, call->deferred, result);
    }
  }
  napi_delete_async_work(env, call->work);
  delete call;
}

/** Reads one string argument into `out`, or returns the fixed reason it was refused. */
const char* ReadString(napi_env env, napi_value value, size_t max_bytes, std::string* out) {
  napi_valuetype type;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_string) return "must be a string";
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok) {
    return "must be a string";
  }
  if (length == 0) return "must not be empty";
  if (length > max_bytes) return "is too long";
  out->resize(length + 1);
  size_t copied = 0;
  if (napi_get_value_string_utf8(env, value, &(*out)[0], out->size(), &copied) != napi_ok ||
      copied != length) {
    Wipe(*out);
    return "must be a string";
  }
  out->resize(length);
  if (out->find('\0') != std::string::npos) {
    Wipe(*out);
    return "must not contain a NUL character";
  }
  return nullptr;
}

struct Argument {
  const char* name;
  size_t max_bytes;
  std::string Call::*field;
};

napi_value Start(napi_env env, napi_callback_info info, Operation operation,
                 const std::vector<Argument>& arguments) {
  napi_value promise;
  napi_deferred deferred;
  if (napi_create_promise(env, &deferred, &promise) != napi_ok) {
    napi_throw_error(env, nullptr, "could not create a promise for a Keychain call");
    return nullptr;
  }

  auto* call = new (std::nothrow) Call(operation);
  if (call == nullptr) {
    Reject(env, deferred, MakeError(env, "Keychain call allocation failed"));
    return promise;
  }
  call->deferred = deferred;

  size_t argc = 4;
  napi_value argv[4];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok ||
      argc != arguments.size()) {
    Reject(env, deferred,
           MakeError(env, std::string("Keychain ") + OperationName(operation) + " requires " +
                              std::to_string(arguments.size()) + " string arguments"));
    delete call;
    return promise;
  }
  for (size_t i = 0; i < arguments.size(); i++) {
    const char* problem = ReadString(env, argv[i], arguments[i].max_bytes, &(call->*arguments[i].field));
    if (problem != nullptr) {
      Reject(env, deferred,
             MakeError(env, std::string("Keychain ") + OperationName(operation) + " " +
                                arguments[i].name + " " + problem));
      delete call;
      return promise;
    }
  }

  napi_value resource_name;
  if (napi_create_string_utf8(env, "MissionControlKeychain", NAPI_AUTO_LENGTH, &resource_name) !=
          napi_ok ||
      napi_create_async_work(env, nullptr, resource_name, Execute, Complete, call, &call->work) !=
          napi_ok ||
      napi_queue_async_work(env, call->work) != napi_ok) {
    if (call->work != nullptr) napi_delete_async_work(env, call->work);
    Reject(env, deferred,
           MakeError(env, std::string("Keychain ") + OperationName(operation) +
                              " could not be queued"));
    delete call;
  }
  return promise;
}

napi_value Get(napi_env env, napi_callback_info info) {
  return Start(env, info, Operation::kGet,
               {{"service", kMaxNameBytes, &Call::service}, {"account", kMaxNameBytes, &Call::account}});
}

napi_value Set(napi_env env, napi_callback_info info) {
  return Start(env, info, Operation::kSet,
               {{"service", kMaxNameBytes, &Call::service},
                {"account", kMaxNameBytes, &Call::account},
                {"value", kMaxValueBytes, &Call::value},
                {"label", kMaxNameBytes, &Call::label}});
}

napi_value Remove(napi_env env, napi_callback_info info) {
  return Start(env, info, Operation::kRemove,
               {{"service", kMaxNameBytes, &Call::service}, {"account", kMaxNameBytes, &Call::account}});
}

napi_value Accounts(napi_env env, napi_callback_info info) {
  return Start(env, info, Operation::kAccounts, {{"service", kMaxNameBytes, &Call::service}});
}

}  // namespace

NAPI_MODULE_INIT() {
  napi_property_descriptor properties[] = {
      {"get", nullptr, Get, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"set", nullptr, Set, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"remove", nullptr, Remove, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"accounts", nullptr, Accounts, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  if (napi_define_properties(env, exports, 4, properties) != napi_ok) {
    napi_throw_error(env, nullptr, "could not initialize native Keychain addon");
    return nullptr;
  }
  return exports;
}
