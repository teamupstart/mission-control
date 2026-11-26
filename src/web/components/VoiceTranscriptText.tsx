import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

export function VoiceTranscriptText({ as: Tag = "div", className = "vc-transcript", id, text, children }: {
  as?: "div" | "span" | "q"; className?: string; id?: string; text: string; children?: ReactNode;
}) {
  const element = useRef<HTMLElement | null>(null);
  const [scrollable, setScrollable] = useState(false);
  useLayoutEffect(() => {
    const node = element.current!;
    const measure = () => setScrollable(node.scrollHeight > node.clientHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [text]);
  return <Tag ref={(node: HTMLElement | null) => { element.current = node; }} className={className} id={id}
    {...(scrollable && { role: "region", "aria-label": "Spoken message", tabIndex: 0 })}>{children ?? text}</Tag>;
}
