"use client";

import { useEffect, useRef, useState } from "react";
import type { ChangeEvent, KeyboardEvent } from "react";

/**
 * Global search bar mounted in the app header (sub-0004-05).
 *
 * Behaviour:
 *
 *   - **Debounced commits.** The user types into the input freely; the
 *     ``onCommit`` callback fires ``debounceMs`` after the last keystroke
 *     so a fast typist doesn't kick off one round-trip per character.
 *   - **Clear button.** A small ``x`` chip appears whenever the field is
 *     non-empty. Pressing it (or hitting ``Esc`` while focused) clears
 *     the input and commits an empty string immediately — no debounce —
 *     so the user gets a fresh unfiltered list without a delay.
 *   - **Submit on Enter / commit on blur.** Pressing ``Enter`` flushes
 *     the pending value synchronously (same path as the clear button).
 *   - **Controlled vs uncontrolled.** The component is fully controlled:
 *     the parent owns the canonical filter state via the
 *     ``TransactionSearchFilters`` payload. ``onCommit`` only signals
 *     "the user wants to apply this value now", so the parent can map
 *     it onto its own state machine without leaking input state into
 *     the URL before the user is done typing.
 */

export interface GlobalSearchBarProps {
  /** Current canonical search query (raw, unsanitised). */
  value: string;
  /** Placeholder shown when the field is empty. */
  placeholder?: string;
  /** Debounce window in ms (defaults to 300 per AC (1)). */
  debounceMs?: number;
  /** Fired with the trimmed string after the debounce window. */
  onCommit: (next: string) => void;
  /** Optional className passthrough for layout alignment in the header. */
  className?: string;
}

const DEFAULT_DEBOUNCE_MS = 300;

export function GlobalSearchBar({
  value,
  placeholder = "Cari catatan transaksi…",
  debounceMs = DEFAULT_DEBOUNCE_MS,
  onCommit,
  className,
}: GlobalSearchBarProps) {
  const [draft, setDraft] = useState<string>(value);
  const lastCommittedRef = useRef<string>(value);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Resync the local draft when the parent flips the canonical value
  // (e.g. URL navigation pushed a new ``?q=``). We only overwrite the
  // draft if the parent value actually changed — typing should never be
  // clobbered by an incoming prop update.
  useEffect(() => {
    if (value === lastCommittedRef.current) return;
    setDraft(value);
    lastCommittedRef.current = value;
  }, [value]);

  // Debounce commits so the search endpoint isn't pinged per keystroke.
  useEffect(() => {
    const trimmed = draft.trim();
    if (trimmed === lastCommittedRef.current) return;
    const timer = window.setTimeout(() => {
      lastCommittedRef.current = trimmed;
      onCommit(trimmed);
    }, debounceMs);
    return () => {
      window.clearTimeout(timer);
    };
  }, [draft, debounceMs, onCommit]);

  const handleChange = (event: ChangeEvent<HTMLInputElement>): void => {
    setDraft(event.target.value);
  };

  const flushNow = (next: string): void => {
    const trimmed = next.trim();
    if (trimmed === lastCommittedRef.current) {
      setDraft(trimmed);
      return;
    }
    lastCommittedRef.current = trimmed;
    setDraft(trimmed);
    onCommit(trimmed);
  };

  const handleClear = (): void => {
    flushNow("");
    inputRef.current?.focus();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Enter") {
      event.preventDefault();
      flushNow(draft);
    } else if (event.key === "Escape" && draft.length > 0) {
      event.preventDefault();
      handleClear();
    }
  };

  const hasValue = draft.length > 0;

  return (
    <div
      className={`relative flex w-full items-center ${className ?? ""}`.trim()}
      role="search"
    >
      <span
        className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-slate-400"
        aria-hidden="true"
      >
        <SearchIcon className="h-4 w-4" />
      </span>
      <input
        ref={inputRef}
        type="search"
        name="global-search"
        autoComplete="off"
        spellCheck={false}
        maxLength={200}
        placeholder={placeholder}
        aria-label="Cari transaksi"
        value={draft}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        className="h-10 w-full rounded-lg border border-slate-200 bg-white pl-9 pr-10 text-sm text-slate-900 shadow-sm placeholder:text-slate-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500"
      />
      {hasValue ? (
        <button
          type="button"
          onClick={handleClear}
          aria-label="Bersihkan pencarian"
          className="absolute inset-y-0 right-2 flex items-center justify-center rounded-md px-1 text-slate-400 transition hover:text-slate-700 focus:outline-none focus:ring-2 focus:ring-brand-500"
        >
          <ClearIcon className="h-4 w-4" />
        </button>
      ) : null}
    </div>
  );
}

function SearchIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}

function ClearIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      <path d="m6 6 12 12M18 6 6 18" />
    </svg>
  );
}