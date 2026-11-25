// Linked into the private test build of the addon in place of the two HAL reads.
#include <CoreAudio/CoreAudio.h>
#include <cstdlib>
#include <cstring>
#include <unistd.h>

namespace {
constexpr AudioObjectID shell = 10, listener = 11, changing = 12, other = 13;
constexpr AudioObjectID processes[] = {shell, listener, changing, other};

bool scenario(const char* name) {
  const char* selected = std::getenv("MC_TEST_MIC_ACTIVITY");
  return selected && std::strcmp(selected, name) == 0;
}

bool processList(AudioObjectID object, const AudioObjectPropertyAddress* address) {
  return object == kAudioObjectSystemObject && address->mSelector == kAudioHardwarePropertyProcessObjectList;
}
}

OSStatus AudioObjectGetPropertyDataSize(AudioObjectID object, const AudioObjectPropertyAddress* address,
                                        UInt32, const void*, UInt32* bytes) {
  if (!processList(object, address)) return kAudioHardwareUnknownPropertyError;
  if (scenario("list-size-error")) return kAudioHardwareBadObjectError;
  *bytes = sizeof(processes);
  return noErr;
}

OSStatus AudioObjectGetPropertyData(AudioObjectID object, const AudioObjectPropertyAddress* address,
                                    UInt32, const void*, UInt32* bytes, void* output) {
  if (processList(object, address)) {
    if (scenario("list-read-error")) return kAudioHardwareBadObjectError;
    if (*bytes < sizeof(processes)) return kAudioHardwareBadPropertySizeError;
    std::memcpy(output, processes, sizeof(processes));
    *bytes = sizeof(processes);
    return noErr;
  }
  if (*bytes != sizeof(UInt32)) return kAudioHardwareBadPropertySizeError;
  if (address->mSelector == kAudioProcessPropertyPID) {
    if (object == changing && scenario("vanished-pid")) return kAudioHardwareBadObjectError;
    if (object == changing && scenario("pid-error")) return kAudioHardwareIllegalOperationError;
    *static_cast<pid_t*>(output) = object == shell ? getpid() : getpid() + object;
    return noErr;
  }
  if (address->mSelector == kAudioProcessPropertyIsRunningInput) {
    if (object == changing && scenario("vanished-input")) return kAudioHardwareBadObjectError;
    if (object == changing && scenario("input-error")) return kAudioHardwareIllegalOperationError;
    *static_cast<UInt32*>(output) = object == shell || object == listener ||
      (object == other && std::getenv("MC_TEST_MIC_OTHER_RUNNING"));
    return noErr;
  }
  return kAudioHardwareUnknownPropertyError;
}
