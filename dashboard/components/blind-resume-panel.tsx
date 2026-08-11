"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Download, FileText, Loader2, RotateCcw, ShieldCheck, Upload } from "lucide-react";
import { blindResumeFilename, buildBlindResumePdf } from "@/lib/blind-resume-pdf";
import type { RedactionOutput, RedactionState } from "@/app/(dashboard)/records/talent/page";

/**
 * Blind resume export (#156), the Talent-screen surface.
 *
 * The feature only has value if the redaction is trustworthy, so the result UI
 * is deliberately asymmetric. A verified-clean run gets a confirmation and a
 * primary download. A run where identifying data survived even the deterministic
 * scrub gets the warning first, every residual finding listed, and a download
 * that is demoted and labelled for what it is. The download is never hidden
 * (someone may legitimately want to fix the document by hand), it just stops
 * being the obvious next click.
 */

interface Props {
  startRedaction: (resumeText: string, candidateCode: string) => Promise<string>;
  getRedactionResult: (runId: string) => Promise<RedactionState>;
  /** From ?run=<id>. Set when arriving from the Teams bot's deep link, which
   *  started the run elsewhere; the panel picks up that run instead of asking
   *  for the resume text a second time. */
  initialRunId?: string;
}

const POLL_MS = 1500;
/** Roughly four minutes of polling before the panel stops waiting. */
const MAX_POLLS = 160;

const TEXT_EXTENSIONS = [".txt", ".md"];

const PHASE_LABEL: Record<string, string> = {
  missing: "Starting",
  pending: "Queued",
  running: "Redacting",
};

function messageOf(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

export function BlindResumePanel({ startRedaction, getRedactionResult, initialRunId }: Props) {
  const [resumeText, setResumeText] = useState("");
  const [candidateCode, setCandidateCode] = useState("");
  const [phase, setPhase] = useState<"idle" | "running" | "done">(initialRunId ? "running" : "idle");
  const [runId, setRunId] = useState<string | null>(initialRunId ?? null);
  const [runStatus, setRunStatus] = useState("missing");
  const [result, setResult] = useState<RedactionOutput | null>(null);
  /** The code the run actually used. The input can be edited afterwards; the
   *  PDF must carry what was submitted, not what is on screen now. */
  const [usedCode, setUsedCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Poll the run until it settles. The loop owns its own scheduling so it can
  // stop itself; the effect only restarts when a new run is started.
  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      if (cancelled) return;
      attempts += 1;

      let state: RedactionState;
      try {
        state = await getRedactionResult(runId);
      } catch (err) {
        if (cancelled) return;
        setError(messageOf(err, "Could not read the redaction run."));
        setPhase("idle");
        return;
      }
      if (cancelled) return;

      if (state.done) {
        if (state.output) {
          setResult(state.output);
          setRunStatus(state.status);
          setPhase("done");
        } else {
          setError(state.error ?? "The redaction run finished without a document.");
          setPhase("idle");
        }
        return;
      }

      setRunStatus(state.status);

      if (attempts >= MAX_POLLS) {
        setError(
          "The redaction is still running after several minutes. It has not failed. " +
            `Follow run ${runId} on the Runs screen and try again once it settles.`,
        );
        setPhase("idle");
        return;
      }

      timer = setTimeout(poll, POLL_MS);
    };

    timer = setTimeout(poll, POLL_MS);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [runId, getRedactionResult]);

  const submit = useCallback(async () => {
    if (phase === "running" || resumeText.trim().length === 0) return;
    const code = candidateCode.trim();
    setError(null);
    setResult(null);
    setRunId(null);
    setRunStatus("missing");
    setPhase("running");
    try {
      const id = await startRedaction(resumeText, code);
      setUsedCode(code);
      setRunId(id);
    } catch (err) {
      setError(messageOf(err, "Could not start the redaction."));
      setPhase("idle");
    }
  }, [phase, resumeText, candidateCode, startRedaction]);

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || phase === "running") return;
    const name = file.name.toLowerCase();
    if (!TEXT_EXTENSIONS.some((ext) => name.endsWith(ext))) {
      setError("Only .txt and .md files can be read here. Attach a PDF to Angie in chat, which reads it directly.");
      if (fileRef.current) fileRef.current.value = "";
      return;
    }
    setError(null);
    file
      .text()
      .then((text) => setResumeText(text))
      .catch(() => setError("That file could not be read."))
      .finally(() => {
        if (fileRef.current) fileRef.current.value = "";
      });
  }

  function reset() {
    setPhase("idle");
    setRunId(null);
    setRunStatus("missing");
    setResult(null);
    setError(null);
  }

  function download() {
    if (!result) return;
    const code = usedCode.length > 0 ? usedCode : undefined;
    const url = URL.createObjectURL(buildBlindResumePdf({ text: result.redacted_resume, candidateCode: code }));
    const a = document.createElement("a");
    a.href = url;
    a.download = blindResumeFilename(code);
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Deferred: revoking in the same tick can cancel the download in some
    // browsers before the blob has been handed to the download manager.
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }

  const running = phase === "running";
  const clean = result?.verified_clean === true;

  return (
    <section className="card pad" style={{ marginBottom: 24 }}>
      <div className="sec-h">
        <h3>Blind resume export</h3>
        <div className="row gap-sm">
          <span className="chip muted mono">angie/resume-redact</span>
          {phase === "done" && (
            <button className="btn sm" onClick={reset}>
              <RotateCcw /> New resume
            </button>
          )}
        </div>
      </div>

      <p className="empty-body" style={{ maxWidth: 800, marginBottom: 16 }}>
        Produces a client-submission copy with the candidate&apos;s identity removed, so a client
        evaluates the experience before the person. The model rewrites, then a deterministic pass
        verifies what it produced and scrubs anything that survived. Employers, dates and numbers
        are kept as written.
      </p>

      {phase !== "done" && (
        <div className="col gap-md" style={{ maxWidth: 820 }}>
          <div className="field">
            <label htmlFor="blind-resume-text">Resume text</label>
            <textarea
              id="blind-resume-text"
              className="ta"
              rows={9}
              style={{ minHeight: 170 }}
              placeholder="Paste the full resume text here."
              value={resumeText}
              onChange={(e) => setResumeText(e.target.value)}
              disabled={running}
            />
            <span className="hint">
              PDF is not parsed here. Attach it to Angie in chat instead: she passes the file
              straight to the model, so there is no need to paste the text back.
            </span>
          </div>

          <div className="row gap-md" style={{ alignItems: "flex-end", flexWrap: "wrap" }}>
            <div className="field" style={{ width: 200 }}>
              <label htmlFor="blind-resume-code">Candidate code (optional)</label>
              <input
                id="blind-resume-code"
                className="input"
                placeholder="LUM-0042"
                value={candidateCode}
                onChange={(e) => setCandidateCode(e.target.value)}
                disabled={running}
              />
            </div>

            <label className="btn" style={{ cursor: running ? "not-allowed" : "pointer" }} title="Load a .txt or .md file into the box above">
              <Upload /> Load .txt or .md
              <input
                ref={fileRef}
                type="file"
                accept=".txt,.md,text/plain,text/markdown"
                style={{ display: "none" }}
                onChange={handleFile}
                disabled={running}
              />
            </label>

            <button className="btn accent" onClick={submit} disabled={running || resumeText.trim().length === 0}>
              {running ? <Loader2 className="spin" /> : <FileText />}
              {running ? "Redacting" : "Redact resume"}
            </button>
          </div>

          <span className="hint" style={{ fontSize: 11.5, color: "var(--ink-2)" }}>
            A candidate code prints on the letterhead in place of the name, so a submission can be
            traced back internally. Leave it blank for a fully anonymous document.
          </span>
        </div>
      )}

      {running && (
        <div className="run-note" style={{ marginTop: 16, maxWidth: 820 }}>
          <span className="run-note-label">
            <Loader2 className="spin" style={{ width: 11, height: 11, verticalAlign: "-1px", marginRight: 6 }} />
            {PHASE_LABEL[runStatus] ?? runStatus}
          </span>
          <p className="run-note-text">
            Removing identifying detail, then verifying the result against the original. This
            usually takes under a minute.
          </p>
          {runId && <span className="run-note-id">{runId}</span>}
        </div>
      )}

      {error && (
        <div className="run-note is-err" style={{ marginTop: 16, maxWidth: 820 }}>
          <span className="run-note-label">
            <AlertTriangle style={{ width: 11, height: 11, verticalAlign: "-1px", marginRight: 6 }} />
            Redaction did not finish
          </span>
          <p className="run-note-text">{error}</p>
        </div>
      )}

      {phase === "done" && result && (
        <div className="col gap-md" style={{ maxWidth: 900, marginTop: 4 }}>
          {clean ? (
            <div className="run-note">
              <span className="run-note-label">
                <ShieldCheck style={{ width: 11, height: 11, verticalAlign: "-1px", marginRight: 6 }} />
                Verified clean
              </span>
              <p className="run-note-text">
                The deterministic sweep found no name, contact detail or personal link left in the
                redacted text. This copy is safe to send to a client.
              </p>
            </div>
          ) : (
            <div className="run-note is-err">
              <span className="run-note-label">
                <AlertTriangle style={{ width: 11, height: 11, verticalAlign: "-1px", marginRight: 6 }} />
                Not safe to send. Identifying data survived the scrub
              </span>
              <p className="run-note-text">
                <strong>Do not send this document to a client as it stands.</strong> The
                deterministic sweep ran after the model and still found the following in the
                output. Fix the resume text by hand and run it again, or edit the downloaded copy
                before it goes anywhere.
              </p>
              {result.residual_findings.length > 0 ? (
                <ul>
                  {result.residual_findings.map((finding, i) => (
                    <li key={`${i}-${finding}`}>{finding}</li>
                  ))}
                </ul>
              ) : (
                <p className="run-note-text">
                  The run did not report which values survived. Read the preview below in full
                  before using it.
                </p>
              )}
            </div>
          )}

          {clean && result.residual_findings.length > 0 && (
            <div className="run-note is-warn">
              <span className="run-note-label">Caught by the scrub</span>
              <p className="run-note-text">
                The model left these behind and the deterministic pass removed them. They are not
                in the document below, but they are worth knowing about.
              </p>
              <ul>
                {result.residual_findings.map((finding, i) => (
                  <li key={`${i}-${finding}`}>{finding}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="run-note">
            <span className="run-note-label">Removed</span>
            {result.removed.length > 0 ? (
              <ul>
                {result.removed.map((item, i) => (
                  <li key={`${i}-${item}`}>{item}</li>
                ))}
              </ul>
            ) : (
              <p className="run-note-text">-</p>
            )}
          </div>

          <div>
            <span className="rd-section-label">Redacted resume</span>
            <pre
              className="sql-block"
              style={{
                maxHeight: 360,
                overflowY: "auto",
                whiteSpace: "pre-wrap",
                border: "1px solid var(--line-2)",
                borderRadius: "var(--radius-sm)",
              }}
            >
              {result.redacted_resume}
            </pre>
          </div>

          <div className="row gap-md" style={{ flexWrap: "wrap" }}>
            {clean ? (
              <>
                <button className="btn accent" onClick={download}>
                  <Download /> Download PDF
                </button>
                <span className="chip ok">Verified clean</span>
              </>
            ) : (
              <>
                <button className="btn danger-out" onClick={download}>
                  <Download /> Download anyway
                </button>
                <span className="chip err">Unsafe to send to a client</span>
              </>
            )}
            <span className="muted" style={{ fontSize: 12 }}>
              {usedCode.length > 0 ? `Letterhead reads "Candidate ${usedCode}".` : "No candidate code on the letterhead."}
            </span>
            <button className="btn sm" onClick={reset}>
              <RotateCcw /> New resume
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

export default BlindResumePanel;
