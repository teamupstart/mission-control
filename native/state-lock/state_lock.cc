#include <errno.h>
#include <fcntl.h>
#include <node_api.h>
#include <sys/file.h>
#include <unistd.h>

#include <cstring>
#include <new>
#include <string>
#include <vector>

namespace {

const napi_type_tag kStateLockHandleTag = {
    0xbedfddbf2a0f416aULL,
    0x8207e506b26bb37eULL,
};

struct StateLockHandle {
  int fd;
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

napi_value ThrowSystemError(napi_env env, const char* code, const std::string& message) {
  napi_value message_value;
  napi_value error;
  napi_value code_value;
  if (napi_create_string_utf8(env, message.c_str(), NAPI_AUTO_LENGTH, &message_value) != napi_ok ||
      napi_create_error(env, nullptr, message_value, &error) != napi_ok ||
      napi_create_string_utf8(env, code, NAPI_AUTO_LENGTH, &code_value) != napi_ok ||
      napi_set_named_property(env, error, "code", code_value) != napi_ok) {
    napi_throw_error(env, nullptr, message.c_str());
    return nullptr;
  }
  napi_throw(env, error);
  return nullptr;
}

bool ReadString(napi_env env, napi_value value, std::string* output) {
  napi_valuetype type;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_string) return false;
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok) return false;
  std::vector<char> bytes(length + 1);
  size_t copied = 0;
  if (napi_get_value_string_utf8(env, value, bytes.data(), bytes.size(), &copied) != napi_ok ||
      copied != length) {
    return false;
  }
  output->assign(bytes.data(), copied);
  return true;
}

bool WriteAll(int fd, const std::string& contents) {
  const char* cursor = contents.data();
  size_t remaining = contents.size();
  while (remaining > 0) {
    const ssize_t written = write(fd, cursor, remaining);
    if (written < 0 && errno == EINTR) continue;
    if (written <= 0) return false;
    cursor += written;
    remaining -= static_cast<size_t>(written);
  }
  return true;
}

void FinalizeStateLock(napi_env, void* data, void*) {
  auto* handle = static_cast<StateLockHandle*>(data);
  if (handle->active) {
    close(handle->fd);
    handle->active = false;
  }
  delete handle;
}

napi_value AcquireStateLock(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 2) {
    return ThrowTypeError(env, "acquire requires a lock path and owner metadata");
  }

  std::string path;
  std::string owner;
  if (!ReadString(env, argv[0], &path) || path.empty()) {
    return ThrowTypeError(env, "acquire lock path must be a non-empty string");
  }
  if (!ReadString(env, argv[1], &owner) || owner.empty()) {
    return ThrowTypeError(env, "acquire owner metadata must be a non-empty string");
  }

  const int fd = open(path.c_str(), O_RDWR | O_CREAT | O_CLOEXEC, 0600);
  if (fd < 0) {
    return ThrowSystemError(
        env,
        "ELOCKOPEN",
        std::string("could not open state ownership file: ") + std::strerror(errno));
  }

  if (flock(fd, LOCK_EX | LOCK_NB) != 0) {
    const int lock_errno = errno;
    close(fd);
    if (lock_errno == EWOULDBLOCK || lock_errno == EAGAIN) {
      return ThrowSystemError(env, "ELOCKED", "state ownership is held by another process");
    }
    return ThrowSystemError(
        env,
        "ELOCKACQUIRE",
        std::string("could not acquire state ownership: ") + std::strerror(lock_errno));
  }

  if (ftruncate(fd, 0) != 0 || lseek(fd, 0, SEEK_SET) < 0 || !WriteAll(fd, owner) || fsync(fd) != 0) {
    const int write_errno = errno;
    close(fd);
    return ThrowSystemError(
        env,
        "ELOCKWRITE",
        std::string("could not write state ownership metadata: ") + std::strerror(write_errno));
  }

  auto* handle = new (std::nothrow) StateLockHandle{fd, true};
  if (handle == nullptr) {
    close(fd);
    return ThrowSystemError(env, "ELOCKHANDLE", "could not allocate state ownership handle");
  }

  napi_value wrapped;
  if (napi_create_object(env, &wrapped) != napi_ok ||
      napi_type_tag_object(env, wrapped, &kStateLockHandleTag) != napi_ok ||
      napi_wrap(env, wrapped, handle, FinalizeStateLock, nullptr, nullptr) != napi_ok) {
    FinalizeStateLock(env, handle, nullptr);
    return ThrowSystemError(env, "ELOCKHANDLE", "could not create state ownership handle");
  }
  return wrapped;
}

napi_value ReleaseStateLock(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 1) {
    return ThrowTypeError(env, "release requires one state ownership handle");
  }

  bool tagged = false;
  if (napi_check_object_type_tag(env, argv[0], &kStateLockHandleTag, &tagged) != napi_ok || !tagged) {
    return ThrowTypeError(env, "release requires a native state ownership handle");
  }
  StateLockHandle* handle = nullptr;
  if (napi_unwrap(env, argv[0], reinterpret_cast<void**>(&handle)) != napi_ok || handle == nullptr) {
    return ThrowTypeError(env, "release requires a native state ownership handle");
  }
  if (!handle->active) return Undefined(env);

  if (ftruncate(handle->fd, 0) != 0 || fsync(handle->fd) != 0) {
    return ThrowSystemError(
        env,
        "ELOCKRELEASE",
        std::string("could not clear state ownership metadata: ") + std::strerror(errno));
  }
  if (close(handle->fd) != 0) {
    return ThrowSystemError(
        env,
        "ELOCKRELEASE",
        std::string("could not release state ownership: ") + std::strerror(errno));
  }
  handle->active = false;
  return Undefined(env);
}

}  // namespace

NAPI_MODULE_INIT() {
  napi_property_descriptor properties[] = {
      {"acquire", nullptr, AcquireStateLock, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"release", nullptr, ReleaseStateLock, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  if (napi_define_properties(env, exports, 2, properties) != napi_ok) {
    napi_throw_error(env, nullptr, "could not initialize native state lock addon");
    return nullptr;
  }
  return exports;
}
