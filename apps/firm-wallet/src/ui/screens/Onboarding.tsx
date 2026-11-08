import { useEffect, useMemo, useState } from "preact/hooks";
import { isValidPhrase, newRecoveryPhrase, normalizePhrase } from "../../core/keys.ts";
import { checkPassword, saveVault, seal, unseal } from "../../core/vault.ts";
import { deviceUnlockAvailable, unlockWithDevice } from "../../core/device-unlock.ts";
import { errorText, setVault, unlockWith, useStore } from "../store.ts";
import { Field } from "../kit.tsx";

type Step = "welcome" | "show" | "check" | "import" | "password";

export function Onboarding() {
  const [step, setStep] = useState<Step>("welcome");
  const [phrase, setPhrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const finish = async (password: string) => {
    setBusy(true);
    setErr("");
    try {
      const vault = await seal(phrase, password);
      await saveVault(vault);
      setVault(vault);
      unlockWith(phrase);
      setPhrase("");
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="center"><div class="narrow stack">
      <p class="eyebrow">$FIRM Wallet™ · Self-custody</p>
      {step === "welcome" && (
        <>
          <h1>Your keys.<br />Your device.</h1>
          <p class="muted">One wallet for ETH, SOL, USDC, wrapped crypto, tokenized stocks and every Infinitum token, with a built-in exchange. Keys are made and kept on this device. Infinitum never holds your funds and can't recover them.</p>
          <button class="btn solid block" onClick={() => { setPhrase(newRecoveryPhrase()); setStep("show"); }}>Create a new wallet</button>
          <button class="btn block" onClick={() => setStep("import")}>I have a recovery phrase</button>
        </>
      )}
      {step === "show" && <ShowPhrase phrase={phrase} onNext={() => setStep("check")} />}
      {step === "check" && <CheckPhrase phrase={phrase} onBack={() => setStep("show")} onNext={() => setStep("password")} />}
      {step === "import" && <ImportPhrase onNext={(p) => { setPhrase(p); setStep("password"); }} onBack={() => setStep("welcome")} />}
      {step === "password" && <SetPassword busy={busy} onSubmit={finish} />}
      {err && <p class="warn">{err}</p>}
    </div></div>
  );
}

function ShowPhrase({ phrase, onNext }: { phrase: string; onNext: () => void }) {
  const [shown, setShown] = useState(false);
  return (
    <>
      <h2>Write down your recovery phrase</h2>
      <p class="small muted">These 12 words restore your wallet on any device. Write them on paper, in order, and keep them offline. Anyone with them controls your funds. Infinitum will never ask for them.</p>
      {shown ? <div class="words">{phrase.split(" ").map((w) => <span>{w}</span>)}</div> : (
        <button class="btn block" onClick={() => setShown(true)}>Show the words (make sure no one can see your screen)</button>
      )}
      <button class="btn solid block" disabled={!shown} onClick={onNext}>I've written them down</button>
    </>
  );
}

function CheckPhrase({ phrase, onBack, onNext }: { phrase: string; onBack: () => void; onNext: () => void }) {
  const words = phrase.split(" ");
  const picks = useMemo(() => {
    const idx = new Set<number>();
    const r = crypto.getRandomValues(new Uint32Array(8));
    for (const n of r) {
      idx.add(n % words.length);
      if (idx.size === 3) break;
    }
    return [...idx].sort((a, b) => a - b);
  }, [phrase]);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const ok = picks.every((i) => (answers[i] ?? "").trim().toLowerCase() === words[i]);
  return (
    <>
      <h2>Check your phrase</h2>
      <p class="small muted">Type these words from what you wrote down.</p>
      {picks.map((i) => (
        <Field label={`Word ${i + 1}`}>
          <input autocomplete="off" autocapitalize="off" spellcheck={false} value={answers[i] ?? ""} onInput={(e) => setAnswers({ ...answers, [i]: (e.target as HTMLInputElement).value })} />
        </Field>
      ))}
      <button class="btn solid block" disabled={!ok} onClick={onNext}>Continue</button>
      <button class="btn ghost block" onClick={onBack}>Show the words again</button>
    </>
  );
}

function ImportPhrase({ onNext, onBack }: { onNext: (p: string) => void; onBack: () => void }) {
  const [text, setText] = useState("");
  const valid = isValidPhrase(text);
  return (
    <>
      <h2>Restore your wallet</h2>
      <Field label="Recovery phrase" hint="12 or 24 words, separated by spaces. It stays on this device.">
        <textarea autocomplete="off" autocapitalize="off" spellcheck={false} value={text} onInput={(e) => setText((e.target as HTMLTextAreaElement).value)} />
      </Field>
      {text && !valid && <p class="small down">That isn't a valid recovery phrase. Check the spelling and the order.</p>}
      <button class="btn solid block" disabled={!valid} onClick={() => onNext(normalizePhrase(text))}>Continue</button>
      <button class="btn ghost block" onClick={onBack}>Back</button>
    </>
  );
}

function SetPassword({ busy, onSubmit }: { busy: boolean; onSubmit: (pw: string) => void }) {
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const problem = pw ? checkPassword(pw) : null;
  return (
    <form class="stack" onSubmit={(e) => { e.preventDefault(); onSubmit(pw); }}>
      <h2>Set a password for this device</h2>
      <p class="small muted">It encrypts your recovery phrase on this device. It isn't a backup: if you forget it, restore with your recovery phrase.</p>
      <Field label="Password"><input type="password" autocomplete="new-password" value={pw} onInput={(e) => setPw((e.target as HTMLInputElement).value)} /></Field>
      <Field label="Repeat password"><input type="password" autocomplete="new-password" value={pw2} onInput={(e) => setPw2((e.target as HTMLInputElement).value)} /></Field>
      {problem && <p class="small down">{problem}</p>}
      {pw2 && pw !== pw2 && <p class="small down">The passwords don't match.</p>}
      <button class="btn solid block" type="submit" disabled={busy || !!problem || !pw || pw !== pw2}>{busy ? "Encrypting…" : "Create wallet"}</button>
    </form>
  );
}

export function Unlock() {
  const { vault, deviceVault } = useStore();
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [canDevice, setCanDevice] = useState(false);
  useEffect(() => void deviceUnlockAvailable().then(setCanDevice), []);
  const withDevice = async () => {
    setBusy(true);
    setErr("");
    try {
      unlockWith(await unlockWithDevice(deviceVault!));
    } catch (x) {
      if (errorText(x) !== "Cancelled.") setErr(errorText(x));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="center"><form class="narrow stack" onSubmit={async (e) => {
      e.preventDefault();
      setBusy(true);
      setErr("");
      try {
        unlockWith(await unseal(vault!, pw));
      } catch (x) {
        setErr(errorText(x));
      } finally {
        setPw("");
        setBusy(false);
      }
    }}>
      <p class="eyebrow">$FIRM Wallet™</p>
      <h1>Unlock</h1>
      {deviceVault && canDevice && (
        <>
          <button class="btn solid block" type="button" disabled={busy} onClick={withDevice}>Unlock with fingerprint or face</button>
          <p class="small muted center-text">or use your password</p>
        </>
      )}
      <Field label="Password"><input type="password" autocomplete="current-password" autofocus={!deviceVault} value={pw} onInput={(e) => setPw((e.target as HTMLInputElement).value)} /></Field>
      {err && <p class="small down">{err}</p>}
      <button class={`btn block ${deviceVault && canDevice ? "" : "solid"}`} type="submit" disabled={busy || !pw}>{busy ? "Unlocking…" : "Unlock"}</button>
      <p class="small muted">Forgot it? Restore with your recovery phrase from Settings after you remove this wallet, or on a new device.</p>
    </form></div>
  );
}
