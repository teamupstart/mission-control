#include <CoreFoundation/CoreFoundation.h>
#include <IOKit/pwr_mgt/IOPMLib.h>
#include <node_api.h>

#include <cstdint>
#include <new>
#include <string>
#include <vector>

namespace {

constexpr size_t kMaxReasonBytes = 128;
const napi_type_tag kAssertionHandleTag = {
    0x8a22c749e7a64353ULL,
    0xa46fe8e4988b502bULL,
};

struct AssertionHandle {
  IOPMAssertionID id;
  bool active;
};

napi_value Undefined(napi_env env) {
  napi_value result;
  if (napi_get_undefined(env, &result) != napi_ok) return nullptr;
  return result;
}

napi_value ThrowTypeError(napi_env env, const char* message) {
  napi_throw_type_error(env, nullptr, message);
  return nullptr;
}

napi_value ThrowError(napi_env env, const std::string& message) {
  napi_throw_error(env, nullptr, message.c_str());
  return nullptr;
}

std::string IOKitFailure(const char* operation, IOReturn code) {
  return std::string("IOKit ") + operation + " failed with code " +
         std::to_string(static_cast<int32_t>(code));
}

void FinalizeAssertion(napi_env, void* data, void*) {
  auto* handle = static_cast<AssertionHandle*>(data);
  if (handle->active) {
    IOPMAssertionRelease(handle->id);
    handle->active = false;
  }
  delete handle;
}

napi_value CreateAssertion(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 1) {
    return ThrowTypeError(env, "create requires one reason string");
  }

  napi_valuetype type;
  if (napi_typeof(env, argv[0], &type) != napi_ok || type != napi_string) {
    return ThrowTypeError(env, "create reason must be a string");
  }

  size_t reason_length = 0;
  if (napi_get_value_string_utf8(env, argv[0], nullptr, 0, &reason_length) != napi_ok) {
    return ThrowTypeError(env, "create reason must be valid UTF-8");
  }
  if (reason_length == 0 || reason_length > kMaxReasonBytes) {
    napi_throw_range_error(env, nullptr, "create reason must be 1 to 128 UTF-8 bytes");
    return nullptr;
  }

  std::vector<char> reason(reason_length + 1);
  size_t copied = 0;
  if (napi_get_value_string_utf8(env, argv[0], reason.data(), reason.size(), &copied) != napi_ok ||
      copied != reason_length) {
    return ThrowTypeError(env, "create reason must be valid UTF-8");
  }

  CFStringRef assertion_name = CFStringCreateWithBytes(
      kCFAllocatorDefault,
      reinterpret_cast<const UInt8*>(reason.data()),
      static_cast<CFIndex>(reason_length),
      kCFStringEncodingUTF8,
      false);
  if (assertion_name == nullptr) {
    return ThrowTypeError(env, "create reason must be valid UTF-8");
  }

  IOPMAssertionID assertion_id = kIOPMNullAssertionID;
  const IOReturn result = IOPMAssertionCreateWithName(
      kIOPMAssertionTypePreventUserIdleSystemSleep,
      kIOPMAssertionLevelOn,
      assertion_name,
      &assertion_id);
  CFRelease(assertion_name);
  if (result != kIOReturnSuccess) {
    return ThrowError(env, IOKitFailure("create", result));
  }

  auto* handle = new (std::nothrow) AssertionHandle{assertion_id, true};
  if (handle == nullptr) {
    IOPMAssertionRelease(assertion_id);
    return ThrowError(env, "native keep-awake handle allocation failed");
  }

  napi_value wrapped;
  if (napi_create_object(env, &wrapped) != napi_ok ||
      napi_type_tag_object(env, wrapped, &kAssertionHandleTag) != napi_ok ||
      napi_wrap(env, wrapped, handle, FinalizeAssertion, nullptr, nullptr) != napi_ok) {
    FinalizeAssertion(env, handle, nullptr);
    return ThrowError(env, "native keep-awake handle creation failed");
  }
  return wrapped;
}

napi_value ReleaseAssertion(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 1) {
    return ThrowTypeError(env, "release requires one assertion handle");
  }

  bool tagged = false;
  if (napi_check_object_type_tag(env, argv[0], &kAssertionHandleTag, &tagged) != napi_ok || !tagged) {
    return ThrowTypeError(env, "release requires a native keep-awake handle");
  }

  AssertionHandle* handle = nullptr;
  if (napi_unwrap(env, argv[0], reinterpret_cast<void**>(&handle)) != napi_ok || handle == nullptr) {
    return ThrowTypeError(env, "release requires a native keep-awake handle");
  }
  if (!handle->active) return Undefined(env);

  const IOReturn result = IOPMAssertionRelease(handle->id);
  if (result != kIOReturnSuccess) {
    return ThrowError(env, IOKitFailure("release", result));
  }
  handle->active = false;
  return Undefined(env);
}

}  // namespace

NAPI_MODULE_INIT() {
  napi_property_descriptor properties[] = {
      {"create", nullptr, CreateAssertion, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"release", nullptr, ReleaseAssertion, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  if (napi_define_properties(env, exports, 2, properties) != napi_ok) {
    napi_throw_error(env, nullptr, "could not initialize native keep-awake addon");
    return nullptr;
  }
  return exports;
}
