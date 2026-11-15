import { useState } from "react";
import { track } from "./track";

export function ShareButton({ text }: { text: string }) {
  const [label, setLabel] = useState("Share result");
  const flash = (l: string) => { setLabel(l); setTimeout(() => setLabel("Share result"), 2000); };
  const share = async () => {
    track("share");
    try {
      if (navigator.share && window.matchMedia("(pointer: coarse)").matches) {
        await navigator.share({ text });
        return;
      }
      await navigator.clipboard.writeText(text);
      flash("Copied");
    } catch (e) {
      if ((e as Error).name !== "AbortError") flash("Couldn't copy");
    }
  };
  return <button className="btn" onClick={share} aria-live="polite">{label}</button>;
}
