// Post only to this fixture's Carbon queue. No system keyboard events or input permissions.
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
static void cleanup(void*) { UnregisterEventHotKey(reserved); }

NAPI_MODULE_INIT() {
  // A separate owner forces a real Carbon refusal while the original chord is live.
  if (RegisterEventHotKey(kVK_F10, cmdKey | controlKey | shiftKey, {'Test', 1},
                          GetApplicationEventTarget(), kEventHotKeyExclusive, &reserved)) {
    napi_throw_error(env, nullptr, "Could not reserve the fixture conflict");
    return nullptr;
  }
  napi_add_env_cleanup_hook(env, cleanup, nullptr);
  napi_value fn;
  napi_create_function(env, "post", NAPI_AUTO_LENGTH, post, nullptr, &fn);
  return fn;
}
