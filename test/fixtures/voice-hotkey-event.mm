// Post only to this fixture's Carbon queue. No system keyboard events or input permissions.
#import <AppKit/AppKit.h>
#import <objc/runtime.h>
#include <Carbon/Carbon.h>
#include <node_api.h>

static napi_value post(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value arg;
  bool down;
  napi_get_cb_info(env, info, &argc, &arg, nullptr, nullptr);
  napi_get_value_bool(env, arg, &down);
  EventHotKeyID id = {'McVc', 1};
  EventRef event;
  OSStatus status = CreateEvent(nullptr, kEventClassKeyboard, down ? kEventHotKeyPressed : kEventHotKeyReleased,
                                GetCurrentEventTime(), kEventAttributeNone, &event);
  if (!status) {
    status = SetEventParameter(event, kEventParamDirectObject, typeEventHotKeyID, sizeof(id), &id);
    if (!status) status = PostEventToQueue(GetMainEventQueue(), event, kEventPriorityStandard);
    ReleaseEvent(event);
  }
  if (status) napi_throw_error(env, nullptr, "Could not enqueue fixture event");
  return nullptr;
}
static EventHotKeyRef reserved;
static void cleanup(void*) {
  if (reserved) UnregisterEventHotKey(reserved);
  reserved = nullptr;
}
static napi_value releaseReservation(napi_env, napi_callback_info) { cleanup(nullptr); return nullptr; }

// Probe physical Carbon codes independently of either registrar's layout translation.
static napi_value physicalKeysAvailable(napi_env env, UInt32 modifiers, UInt32 first, UInt32 second) {
  const UInt32 keys[] = {first, second};
  napi_value result;
  napi_create_array_with_length(env, 2, &result);
  for (UInt32 i = 0; i < 2; ++i) {
    EventHotKeyRef probe;
    OSStatus status = RegisterEventHotKey(keys[i], modifiers, {'Test', 2 + i},
                                          GetApplicationEventTarget(), kEventHotKeyExclusive, &probe);
    if (!status) UnregisterEventHotKey(probe);
    else if (status != eventHotKeyExistsErr) {
      napi_throw_error(env, nullptr, "Could not probe the modifier and physical key");
      return nullptr;
    }
    napi_value available;
    napi_get_boolean(env, !status, &available);
    napi_set_element(env, result, i, available);
  }
  return result;
}
static napi_value plusKeysAvailable(napi_env env, napi_callback_info) {
  return physicalKeysAvailable(env, controlKey | shiftKey, kVK_ANSI_Equal, kVK_ANSI_KeypadPlus);
}
static napi_value sevenKeysAvailable(napi_env env, napi_callback_info) {
  return physicalKeysAvailable(env, controlKey | shiftKey, kVK_ANSI_7, kVK_ANSI_Keypad7);
}
static napi_value layoutKeysAvailable(napi_env env, napi_callback_info) {
  return physicalKeysAvailable(env, cmdKey | controlKey | optionKey | shiftKey, kVK_ANSI_V, kVK_ANSI_Period);
}

// Change only this fixture process's NSWorkspace getter and send real KVO.
static bool fixtureVoiceOver;
static IMP originalVoiceOver;
static BOOL readVoiceOver(id, SEL) { return fixtureVoiceOver; }

static napi_value setVoiceOver(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value value;
  napi_get_cb_info(env, info, &argc, &value, nullptr, nullptr);
  NSWorkspace* workspace = NSWorkspace.sharedWorkspace;
  Method getter = class_getInstanceMethod([NSWorkspace class], @selector(isVoiceOverEnabled));
  [workspace willChangeValueForKey:@"voiceOverEnabled"];
  if (argc) {
    napi_get_value_bool(env, value, &fixtureVoiceOver);
    if (!originalVoiceOver) originalVoiceOver = method_setImplementation(getter, (IMP)readVoiceOver);
  } else if (originalVoiceOver) {
    method_setImplementation(getter, originalVoiceOver);
    originalVoiceOver = nullptr;
  }
  [workspace didChangeValueForKey:@"voiceOverEnabled"];
  return nullptr;
}

NAPI_MODULE_INIT() {
  // A separate owner forces a real Carbon refusal while the original chord is live.
  if (RegisterEventHotKey(kVK_F10, cmdKey | controlKey | shiftKey, {'Test', 1},
                          GetApplicationEventTarget(), kEventHotKeyExclusive, &reserved)) {
    napi_throw_error(env, nullptr, "Could not reserve the fixture conflict");
    return nullptr;
  }
  napi_add_env_cleanup_hook(env, cleanup, nullptr);
  napi_property_descriptor props[] = {
    {"setVoiceOver", nullptr, setVoiceOver, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"post", nullptr, post, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"releaseReservation", nullptr, releaseReservation, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"plusKeysAvailable", nullptr, plusKeysAvailable, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"sevenKeysAvailable", nullptr, sevenKeysAvailable, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"layoutKeysAvailable", nullptr, layoutKeysAvailable, nullptr, nullptr, nullptr, napi_default, nullptr}
  };
  napi_define_properties(env, exports, sizeof(props) / sizeof(props[0]), props);
  return exports;
}
