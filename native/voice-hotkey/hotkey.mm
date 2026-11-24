#include <Carbon/Carbon.h>
#include <node_api.h>
#include <string>
#include <map>
#include <optional>

// Electron main owns the application event target and dispatches both Carbon events.
namespace {
constexpr OSType signature = 'McVc';
EventHandlerRef handler;
EventHotKeyRef active;
UInt32 activeCode, activeModifiers;
UInt32 generation;
napi_threadsafe_function callback;

struct Edge { UInt32 generation; bool down; double hostUs; };

void deliver(napi_env env, napi_value fn, void*, void* data) {
  auto edge = static_cast<Edge*>(data);
  if (env && active && edge->generation == generation) {
    napi_value self, args[2];
    napi_get_undefined(env, &self);
    napi_get_boolean(env, edge->down, &args[0]);
    napi_create_double(env, edge->hostUs, &args[1]);
    napi_call_function(env, self, fn, 2, args, nullptr);
  }
  delete edge;
}

OSStatus receive(EventHandlerCallRef, EventRef event, void*) {
  EventHotKeyID id;
  if (GetEventParameter(event, kEventParamDirectObject, typeEventHotKeyID, nullptr,
                        sizeof(id), nullptr, &id) || id.signature != signature || id.id != generation || !active)
    return eventNotHandledErr;
  auto edge = new Edge{id.id, GetEventKind(event) == kEventHotKeyPressed, GetEventTime(event) * 1000000};
  if (napi_call_threadsafe_function(callback, edge, napi_tsfn_nonblocking) != napi_ok) delete edge;
  return noErr;
}

void clear(void*) {
  if (active) UnregisterEventHotKey(active);
  if (handler) RemoveEventHandler(handler);
  if (callback) napi_release_threadsafe_function(callback, napi_tsfn_release);
  active = nullptr;
  handler = nullptr;
  callback = nullptr;
}

napi_value fail(napi_env env, const std::string& why) {
  napi_throw_error(env, nullptr, why.c_str());
  return nullptr;
}

const std::map<std::string, UInt32> nonTypingKeys = {
    {"Home", kVK_Home}, {"End", kVK_End},
    {"ArrowLeft", kVK_LeftArrow}, {"ArrowRight", kVK_RightArrow}, {"ArrowUp", kVK_UpArrow},
    {"ArrowDown", kVK_DownArrow}, {"PageUp", kVK_PageUp}, {"PageDown", kVK_PageDown},
    {"F1", kVK_F1}, {"F2", kVK_F2}, {"F3", kVK_F3}, {"F4", kVK_F4}, {"F5", kVK_F5},
    {"F6", kVK_F6}, {"F7", kVK_F7}, {"F8", kVK_F8}, {"F9", kVK_F9}, {"F10", kVK_F10},
    {"F11", kVK_F11}, {"F12", kVK_F12}
};

// Translate typing keys with the selected input source's layout, including shifted punctuation.
std::optional<UInt32> typingKeyCode(const std::string& key, UInt32& modifiers) {
  static const std::map<std::string, UInt32> named = {
    {"Space", kVK_Space}, {"Tab", kVK_Tab}, {"Enter", kVK_Return},
    {"Backspace", kVK_Delete}, {"Delete", kVK_ForwardDelete}
  };
  auto found = named.find(key);
  if (found != named.end()) return found->second;
  auto source = TISCopyCurrentKeyboardLayoutInputSource();
  if (!source) return {};
  auto data = static_cast<CFDataRef>(TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData));
  std::optional<UInt32> result;
  if (data) {
    const auto layout = reinterpret_cast<const UCKeyboardLayout*>(CFDataGetBytePtr(data));
    for (UInt32 level : {0u, UInt32(shiftKey), UInt32(optionKey), UInt32(shiftKey | optionKey)}) {
      if ((level & optionKey) && !(modifiers & optionKey)) continue;
      for (UInt16 code = 0; code < 128; ++code) {
        UniChar chars[8];
        UniCharCount count = 0;
        UInt32 dead = 0;
        if (UCKeyTranslate(layout, code, kUCKeyActionDisplay, level >> 8, LMGetKbdType(),
                           kUCKeyTranslateNoDeadKeysMask, &dead, 8, &count, chars) || !count) continue;
        char utf8[40];
        CFStringRef value = CFStringCreateWithCharacters(nullptr, chars, count);
        bool match = CFStringGetCString(value, utf8, sizeof(utf8), kCFStringEncodingUTF8) && key == utf8;
        CFRelease(value);
        if (match) { result = code; modifiers |= level; break; }
      }
      if (result) break;
    }
  }
  CFRelease(source);
  return result;
}

napi_value replace(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2], name;
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  char chord[512];
  size_t length;
  if (argc != 2 || napi_get_value_string_utf8(env, args[0], chord, sizeof(chord), &length) != napi_ok)
    return fail(env, "Expected a chord and a callback.");
  std::string key(chord, length);
  UInt32 modifiers = 0;
  const std::map<std::string, UInt32> bits = {{"cmd",cmdKey},{"alt",optionKey},{"shift",shiftKey},{"ctrl",controlKey}};
  while (key.size() > 1) {
    auto plus = key.find('+');
    if (plus == std::string::npos) break;
    auto mod = bits.find(key.substr(0, plus));
    if (mod == bits.end()) return fail(env, "Unknown modifier.");
    modifiers |= mod->second;
    key.erase(0, plus + 1);
  }
  std::optional<UInt32> code;
  auto special = nonTypingKeys.find(key);
  if (special != nonTypingKeys.end()) {
    code = special->second;
  } else {
    if (!(modifiers & (cmdKey | controlKey | optionKey)))
      return fail(env, "Use Command, Control, or Option with a typing key.");
    code = typingKeyCode(key, modifiers);
  }
  if (!code) return fail(env, "This key is unavailable on the current keyboard layout.");
  napi_value changed;
  if (active && activeCode == *code && activeModifiers == modifiers) {
    napi_get_boolean(env, false, &changed);
    return changed;
  }
  EventTypeSpec events[] = {{kEventClassKeyboard, kEventHotKeyPressed},{kEventClassKeyboard, kEventHotKeyReleased}};
  if (!handler && InstallApplicationEventHandler(receive, 2, events, nullptr, &handler))
    return fail(env, "Cannot install the application hotkey handler.");
  napi_threadsafe_function next;
  napi_create_string_utf8(env, "Voice hotkey", NAPI_AUTO_LENGTH, &name);
  if (napi_create_threadsafe_function(env, args[1], nullptr, name, 0, 1, nullptr, nullptr, nullptr, deliver, &next) != napi_ok)
    return fail(env, "Cannot create the hotkey callback.");
  EventHotKeyRef replacement;
  auto status = RegisterEventHotKey(*code, modifiers, {signature, generation + 1}, GetApplicationEventTarget(), kEventHotKeyExclusive, &replacement);
  if (status) {
    napi_release_threadsafe_function(next, napi_tsfn_release);
    return fail(env, status == eventHotKeyExistsErr ? "another app already owns it." : "Carbon registration failed (" + std::to_string(status) + ").");
  }
  if (active) UnregisterEventHotKey(active);
  if (callback) napi_release_threadsafe_function(callback, napi_tsfn_release);
  active = replacement;
  activeCode = *code;
  activeModifiers = modifiers;
  callback = next;
  ++generation;
  napi_get_boolean(env, true, &changed);
  return changed;
}
napi_value unregister(napi_env, napi_callback_info) { clear(nullptr); return nullptr; }
}

NAPI_MODULE_INIT() {
  napi_add_env_cleanup_hook(env, clear, nullptr);
  napi_property_descriptor props[] = {
    {"register", nullptr, replace, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"unregister", nullptr, unregister, nullptr, nullptr, nullptr, napi_default, nullptr}
  };
  napi_define_properties(env, exports, 2, props);
  return exports;
}
