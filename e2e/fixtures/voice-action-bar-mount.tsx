import { createRoot } from "react-dom/client";
import { ActionBar, type ActionBarHandle } from "../../src/web/components/ActionBar.tsx";
import { VoiceWindowProvider } from "../../src/web/components/VoiceIndicators.tsx";
import { useEventStream } from "../../src/web/useEventStream.ts";

function openComposer(_id: string, actions: ActionBarHandle | null) {
  actions?.startSend();
}

function Fallback() {
  const { sessions, voice } = useEventStream();
  const session = sessions[0];
  if (!session) return null;
  return <VoiceWindowProvider enabled state={voice} openSetup={() => {}}>
    <ActionBar session={session} registerActions={openComposer} />
  </VoiceWindowProvider>;
}

export function mountFallback() {
  const host = document.createElement("div");
  document.body.prepend(host);
  createRoot(host).render(<Fallback />);
}
