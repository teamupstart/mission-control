import { createElement, type ComponentProps } from "react";
import { SettingsPage } from "../../src/web/components/SettingsPage.tsx";
import { useVoiceConfig } from "../../src/web/useVoiceConfig.ts";

export function SettingsPageFixture(props: Omit<ComponentProps<typeof SettingsPage>, "voiceConfig">) {
  return createElement(SettingsPage, { ...props, voiceConfig: useVoiceConfig(false) });
}
