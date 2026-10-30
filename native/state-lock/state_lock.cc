#if defined(__linux__) && !defined(_GNU_SOURCE)
#define _GNU_SOURCE
#endif

#include <errno.h>
#include <dirent.h>
#include <fcntl.h>
#include <node_api.h>
#include <stdio.h>
#include <sys/file.h>
#include <sys/stat.h>
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

// Node's link() follows symlinks on Darwin. linkat with flags=0 preserves the
// private symlink's inode and atomically refuses any occupied destination.
napi_value LinkSymlinkNoReplace(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  std::string source;
  std::string destination;
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 2 ||
      !ReadString(env, argv[0], &source) || !ReadString(env, argv[1], &destination) ||
      source.find('\0') != std::string::npos || destination.find('\0') != std::string::npos) {
    return ThrowTypeError(env, "linkSymlinkNoReplace requires two filesystem paths");
  }
  struct stat entry;
  if (lstat(source.c_str(), &entry) != 0) {
    return ThrowSystemError(env, "ELINK", std::string("could not inspect staged symlink: ") + std::strerror(errno));
  }
  if (!S_ISLNK(entry.st_mode)) return ThrowTypeError(env, "publication source must be a symlink");
  int result;
  do { result = linkat(AT_FDCWD, source.c_str(), AT_FDCWD, destination.c_str(), 0); }
  while (result != 0 && errno == EINTR);
  if (result != 0) {
    const int error = errno;
    return ThrowSystemError(env, error == EEXIST ? "EEXIST" : "ELINK",
                           std::string("could not publish staged symlink: ") + std::strerror(error));
  }
  return Undefined(env);
}

// Both operations preserve the destination: exchange retains it at source, and
// exclusive rename refuses an occupied destination, including an empty directory.
napi_value RenamePaths(napi_env env, napi_callback_info info, bool exchange) {
  size_t argc = 2;
  napi_value argv[2];
  std::string source;
  std::string destination;
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 2 ||
      !ReadString(env, argv[0], &source) || !ReadString(env, argv[1], &destination) ||
      source.find('\0') != std::string::npos || destination.find('\0') != std::string::npos) {
    return ThrowTypeError(env, "rename requires two filesystem paths");
  }
  int result;
  do {
#ifdef __APPLE__
    result = renameatx_np(AT_FDCWD, source.c_str(), AT_FDCWD, destination.c_str(),
                         exchange ? RENAME_SWAP : RENAME_EXCL);
#else
    result = renameat2(AT_FDCWD, source.c_str(), AT_FDCWD, destination.c_str(),
                       exchange ? RENAME_EXCHANGE : RENAME_NOREPLACE);
#endif
  } while (result != 0 && errno == EINTR);
  if (result != 0) {
    const int error = errno;
    return ThrowSystemError(env, error == EEXIST ? "EEXIST" : error == ENOENT ? "ENOENT" : "ERENAME",
                           std::string("could not move publication entry: ") + std::strerror(error));
  }
  return Undefined(env);
}

napi_value ExchangePaths(napi_env env, napi_callback_info info) { return RenamePaths(env, info, true); }
napi_value RenameNoReplace(napi_env env, napi_callback_info info) { return RenamePaths(env, info, false); }

// Plan filesystem operations resolve one component at a time from held directory
// descriptors. Never accept a path here: even an intermediate symlink would defeat
// O_NOFOLLOW, which protects only the final component of openat.
bool ReadEntry(napi_env env, napi_value value, std::string* output) {
  return ReadString(env, value, output) && !output->empty() &&
      *output != "." && *output != ".." && output->find('/') == std::string::npos &&
      output->find('\0') == std::string::npos;
}

napi_value PlanIoError(napi_env env) {
  const int error = errno;
  const char* code = error == ENOENT ? "ENOENT" : error == EEXIST ? "EEXIST" :
      error == ELOOP ? "ELOOP" : error == ENOTDIR ? "ENOTDIR" : "EPLANIO";
  return ThrowSystemError(env, code, std::string("anchored plan filesystem operation failed: ") + std::strerror(error));
}

napi_value OpenPlanEntry(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  int32_t parent, flags;
  std::string name;
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 3 ||
      napi_get_value_int32(env, argv[0], &parent) != napi_ok || parent < 0 ||
      !ReadEntry(env, argv[1], &name) || napi_get_value_int32(env, argv[2], &flags) != napi_ok) {
    return ThrowTypeError(env, "openPlanEntry requires a directory descriptor, one entry name, and flags");
  }
  int fd;
  do { fd = openat(parent, name.c_str(), flags | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK, 0600); }
  while (fd < 0 && errno == EINTR);
  if (fd < 0) return PlanIoError(env);
  napi_value result;
  if (napi_create_int32(env, fd, &result) != napi_ok) {
    close(fd);
    return nullptr;
  }
  return result;
}

napi_value MakePlanDirectory(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  int32_t parent;
  std::string name;
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 2 ||
      napi_get_value_int32(env, argv[0], &parent) != napi_ok || parent < 0 || !ReadEntry(env, argv[1], &name)) {
    return ThrowTypeError(env, "makePlanDirectory requires a directory descriptor and one entry name");
  }
  if (mkdirat(parent, name.c_str(), 0700) != 0 && errno != EEXIST) return PlanIoError(env);
  return Undefined(env);
}

napi_value RenamePlanEntry(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value argv[4];
  int32_t parent;
  bool exchange;
  std::string source, destination;
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 4 ||
      napi_get_value_int32(env, argv[0], &parent) != napi_ok || parent < 0 ||
      !ReadEntry(env, argv[1], &source) || !ReadEntry(env, argv[2], &destination) ||
      napi_get_value_bool(env, argv[3], &exchange) != napi_ok) {
    return ThrowTypeError(env, "renamePlanEntry requires a directory descriptor, two entry names, and an exchange flag");
  }
  int result;
  do {
#ifdef __APPLE__
    result = renameatx_np(parent, source.c_str(), parent, destination.c_str(), exchange ? RENAME_SWAP : RENAME_EXCL);
#else
    result = renameat2(parent, source.c_str(), parent, destination.c_str(), exchange ? RENAME_EXCHANGE : RENAME_NOREPLACE);
#endif
  }
  while (result != 0 && errno == EINTR);
  if (result != 0) return PlanIoError(env);
  return Undefined(env);
}

napi_value UnlinkPlanEntry(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  int32_t parent;
  bool directory;
  std::string name;
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 3 ||
      napi_get_value_int32(env, argv[0], &parent) != napi_ok || parent < 0 || !ReadEntry(env, argv[1], &name) ||
      napi_get_value_bool(env, argv[2], &directory) != napi_ok) {
    return ThrowTypeError(env, "unlinkPlanEntry requires a directory descriptor, one entry name, and a directory flag");
  }
  if (unlinkat(parent, name.c_str(), directory ? AT_REMOVEDIR : 0) != 0 && errno != ENOENT) return PlanIoError(env);
  return Undefined(env);
}

napi_value ReadPlanDirectory(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  int32_t parent;
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 1 ||
      napi_get_value_int32(env, argv[0], &parent) != napi_ok || parent < 0) {
    return ThrowTypeError(env, "readPlanDirectory requires a directory descriptor");
  }
  // A fresh open description keeps directory offsets independent of the held handle.
  const int fd = openat(parent, ".", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  if (fd < 0) return PlanIoError(env);
  DIR* directory = fdopendir(fd);
  if (!directory) { const int error = errno; close(fd); errno = error; return PlanIoError(env); }
  std::vector<std::string> names;
  errno = 0;
  while (dirent* entry = readdir(directory)) {
    if (std::strcmp(entry->d_name, ".") && std::strcmp(entry->d_name, "..")) names.emplace_back(entry->d_name);
    errno = 0;
  }
  const int error = errno;
  closedir(directory);
  if (error) { errno = error; return PlanIoError(env); }
  napi_value result;
  if (napi_create_array_with_length(env, names.size(), &result) != napi_ok) return nullptr;
  for (size_t i = 0; i < names.size(); ++i) {
    napi_value name;
    if (napi_create_string_utf8(env, names[i].c_str(), names[i].size(), &name) != napi_ok ||
        napi_set_element(env, result, i, name) != napi_ok) return nullptr;
  }
  return result;
}

struct RemoveDirectoryWork {
  int parent;
  std::string name;
  int error = 0;
  napi_async_work work;
  napi_deferred deferred;
};

// All traversal and unlink operations stay relative to held descriptors. A name swapped
// for a symlink is either unlinked as an entry or refused, never followed. The explicit
// stack avoids native stack growth on an agent-created deeply nested tree.
void RemoveDirectoryExecute(napi_env, void* data) {
  auto* work = static_cast<RemoveDirectoryWork*>(data);
  struct Frame { DIR* directory; int parent; std::string name; };
  std::vector<Frame> stack;
  const int root = openat(work->parent, work->name.c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (root < 0) {
    if (errno != ENOENT) work->error = errno;
  } else {
    DIR* directory = fdopendir(root);
    if (!directory) { work->error = errno; close(root); }
    else stack.push_back({directory, work->parent, work->name});
  }
  while (!stack.empty() && !work->error) {
    auto& frame = stack.back();
    errno = 0;
    dirent* entry = readdir(frame.directory);
    if (!entry) {
      if (errno) { work->error = errno; break; }
      const int parent = frame.parent;
      const std::string name = frame.name;
      closedir(frame.directory);
      stack.pop_back();
      if (unlinkat(parent, name.c_str(), AT_REMOVEDIR) != 0 && errno != ENOENT) work->error = errno;
      continue;
    }
    if (!std::strcmp(entry->d_name, ".") || !std::strcmp(entry->d_name, "..")) continue;
    const int parent = dirfd(frame.directory);
    const std::string name = entry->d_name;
    const int child = openat(parent, name.c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (child >= 0) {
      DIR* directory = fdopendir(child);
      if (!directory) { work->error = errno; close(child); break; }
      stack.push_back({directory, parent, name});
    } else if (errno == ENOTDIR || errno == ELOOP) {
      if (unlinkat(parent, name.c_str(), 0) != 0 && errno != ENOENT) work->error = errno;
    } else if (errno != ENOENT) {
      work->error = errno;
    }
  }
  for (auto& frame : stack) closedir(frame.directory);
  close(work->parent);
  work->parent = -1;
}

void RemoveDirectoryComplete(napi_env env, napi_status status, void* data) {
  auto* work = static_cast<RemoveDirectoryWork*>(data);
  if (work->parent >= 0) close(work->parent);
  if (work->error || status != napi_ok) {
    const std::string reason = work->error ? std::strerror(work->error) : "filesystem worker failed";
    napi_value message, error;
    napi_create_string_utf8(env, reason.c_str(), reason.size(), &message);
    napi_create_error(env, nullptr, message, &error);
    napi_reject_deferred(env, work->deferred, error);
  } else {
    napi_resolve_deferred(env, work->deferred, Undefined(env));
  }
  napi_delete_async_work(env, work->work);
  delete work;
}

napi_value RemovePlanDirectory(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  int32_t parent;
  std::string name;
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 2 ||
      napi_get_value_int32(env, argv[0], &parent) != napi_ok || parent < 0 || !ReadEntry(env, argv[1], &name)) {
    return ThrowTypeError(env, "removePlanDirectory requires a directory descriptor and one entry name");
  }
  const int held = fcntl(parent, F_DUPFD_CLOEXEC, 0);
  if (held < 0) return PlanIoError(env);
  auto* work = new (std::nothrow) RemoveDirectoryWork{held, name};
  if (!work) { close(held); return ThrowSystemError(env, "ENOMEM", "could not allocate directory removal"); }
  napi_value promise, resource;
  if (napi_create_promise(env, &work->deferred, &promise) != napi_ok ||
      napi_create_string_utf8(env, "anchored directory removal", NAPI_AUTO_LENGTH, &resource) != napi_ok ||
      napi_create_async_work(env, nullptr, resource, RemoveDirectoryExecute, RemoveDirectoryComplete, work, &work->work) != napi_ok) {
    close(held); delete work; return nullptr;
  }
  if (napi_queue_async_work(env, work->work) != napi_ok) {
    napi_delete_async_work(env, work->work); close(held); delete work; return nullptr;
  }
  return promise;
}

}  // namespace

NAPI_MODULE_INIT() {
  napi_property_descriptor properties[] = {
      {"acquire", nullptr, AcquireStateLock, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"release", nullptr, ReleaseStateLock, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"linkSymlinkNoReplace", nullptr, LinkSymlinkNoReplace, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"exchangePaths", nullptr, ExchangePaths, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"renameNoReplace", nullptr, RenameNoReplace, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"openPlanEntry", nullptr, OpenPlanEntry, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"makePlanDirectory", nullptr, MakePlanDirectory, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"renamePlanEntry", nullptr, RenamePlanEntry, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"unlinkPlanEntry", nullptr, UnlinkPlanEntry, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"readPlanDirectory", nullptr, ReadPlanDirectory, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"removePlanDirectory", nullptr, RemovePlanDirectory, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  if (napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties) != napi_ok) {
    napi_throw_error(env, nullptr, "could not initialize native state lock addon");
    return nullptr;
  }
  return exports;
}
