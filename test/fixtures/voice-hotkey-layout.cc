// Link only into the private test addon. Read installed layouts without switching the user's input source.
#include <Carbon/Carbon.h>
#include <cstdlib>

TISInputSourceRef TISCopyCurrentKeyboardLayoutInputSource() {
  const void* key = kTISPropertyInputSourceID;
  const void* id = std::getenv("MC_TEST_VOICE_DVORAK") ? CFSTR("com.apple.keylayout.Dvorak") : CFSTR("com.apple.keylayout.US");
  auto query = CFDictionaryCreate(nullptr, &key, &id, 1, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
  auto matches = TISCreateInputSourceList(query, true);
  CFRelease(query);
  TISInputSourceRef source = nullptr;
  if (matches && CFArrayGetCount(matches)) {
    source = (TISInputSourceRef)CFRetain(CFArrayGetValueAtIndex(matches, 0));
  }
  if (matches) CFRelease(matches);
  return source;
}
