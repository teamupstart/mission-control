#include <CoreAudio/CoreAudio.h>
#include <node_api.h>
#include <unistd.h>
#include <string>
#include <vector>

static napi_value failure(napi_env env, OSStatus status) {
  auto message = "CoreAudio input query failed (" + std::to_string(status) + ").";
  napi_throw_error(env, nullptr, message.c_str());
  return nullptr;
}

static napi_value running(napi_env env, napi_callback_info info) {
  if (@available(macOS 14.2, *)) {
    napi_value arg;
    size_t argc = 1;
    int32_t listener = -1;
    napi_get_cb_info(env, info, &argc, &arg, nullptr, nullptr);
    if (argc) napi_get_value_int32(env, arg, &listener);
    AudioObjectPropertyAddress property = {kAudioHardwarePropertyProcessObjectList,
      kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain};
    UInt32 bytes = 0;
    OSStatus status = AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, &property, 0, nullptr, &bytes);
    if (status) return failure(env, status);
    std::vector<AudioObjectID> objects(bytes / sizeof(AudioObjectID));
    if (bytes) status = AudioObjectGetPropertyData(kAudioObjectSystemObject, &property, 0, nullptr, &bytes, objects.data());
    if (status) return failure(env, status);
    bool busy = false;
    for (size_t i = 0; i < bytes / sizeof(AudioObjectID); ++i) {
      pid_t pid;
      UInt32 size = sizeof(pid);
      property.mSelector = kAudioProcessPropertyPID;
      status = AudioObjectGetPropertyData(objects[i], &property, 0, nullptr, &size, &pid);
      if (status == kAudioHardwareBadObjectError) continue;
      if (status) return failure(env, status);
      if (pid == getpid() || pid == listener) continue;
      UInt32 input;
      size = sizeof(input);
      property.mSelector = kAudioProcessPropertyIsRunningInput;
      status = AudioObjectGetPropertyData(objects[i], &property, 0, nullptr, &size, &input);
      if (status == kAudioHardwareBadObjectError) continue;
      if (status) return failure(env, status);
      busy |= input != 0;
    }
    napi_value result;
    napi_get_boolean(env, busy, &result);
    return result;
  }
  napi_throw_error(env, nullptr, "Call detection requires macOS 14.2 or later.");
  return nullptr;
}

NAPI_MODULE_INIT() {
  napi_property_descriptor prop = {"running", nullptr, running, nullptr, nullptr, nullptr, napi_default, nullptr};
  napi_define_properties(env, exports, 1, &prop);
  return exports;
}
