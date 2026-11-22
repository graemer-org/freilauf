import { useEffect, useId, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';

/**
 * Text-ish input that edits a local draft and commits on blur or Enter.
 * `parse` returns the value to commit, or `undefined` when the draft is
 * invalid — then the field reverts to the stored value. Escape reverts.
 */
function useDraft<T>(
  value: T,
  format: (v: T) => string,
  parse: (text: string) => T | undefined,
  onCommit: (v: T) => void,
) {
  const [draft, setDraft] = useState(() => format(value));
  const [invalid, setInvalid] = useState(false);
  const formatted = format(value);
  // Follow external changes (another window, a sanitised value from main).
  useEffect(() => {
    setDraft(formatted);
    setInvalid(false);
  }, [formatted]);

  const commit = (): void => {
    const parsed = parse(draft);
    if (parsed === undefined) {
      setDraft(formatted);
      setInvalid(true);
      return;
    }
    setInvalid(false);
    setDraft(format(parsed));
    if (format(parsed) !== formatted) onCommit(parsed);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      setDraft(formatted);
      setInvalid(false);
    }
  };
  return { draft, setDraft, invalid, commit, onKeyDown };
}

interface FieldShellProps {
  id: string;
  label: string;
  hint?: ReactNode | undefined;
  error?: string | null | undefined;
  children: ReactNode;
}

function FieldShell({ id, label, hint, error, children }: FieldShellProps) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children}
      {error ? (
        <span className="field-error" role="alert">
          {error}
        </span>
      ) : hint ? (
        <span className="field-hint">{hint}</span>
      ) : null}
    </div>
  );
}

export interface NumberFieldProps {
  label: string;
  value: number | null;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  /** When true, an empty field commits `null`. */
  allowEmpty?: boolean;
  placeholder?: string;
  hint?: ReactNode;
  testId?: string;
  onCommit: (value: number | null) => void;
}

export function NumberField(props: NumberFieldProps) {
  const id = useId();
  const { label, value, min, max, step = 1, unit, allowEmpty = false, onCommit } = props;
  const { draft, setDraft, invalid, commit, onKeyDown } = useDraft<number | null>(
    value,
    (v) => (v === null ? '' : String(v)),
    (text) => {
      const t = text.trim().replace(',', '.');
      if (t === '') return allowEmpty ? null : undefined;
      const n = Number(t);
      if (!Number.isFinite(n) || n < min || n > max) return undefined;
      return n;
    },
    onCommit,
  );
  return (
    <FieldShell
      id={id}
      label={unit ? `${label} (${unit})` : label}
      hint={props.hint}
      error={
        invalid
          ? `Enter a number from ${min} to ${max}${allowEmpty ? ', or leave empty' : ''}.`
          : null
      }
    >
      <input
        id={id}
        data-testid={props.testId}
        // Text, not type=number: Chromium reports unparsable input as "",
        // which would be indistinguishable from a deliberately empty field.
        type="text"
        inputMode="decimal"
        autoComplete="off"
        placeholder={props.placeholder}
        aria-invalid={invalid || undefined}
        value={draft}
        onChange={(e) => setDraft(e.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            // Step like a number input, committing right away.
            e.preventDefault();
            const base = value ?? min;
            const next = base + (e.key === 'ArrowUp' ? step : -step);
            const clamped = Math.min(max, Math.max(min, Number(next.toFixed(6))));
            setDraft(String(clamped));
            if (clamped !== value) onCommit(clamped);
            return;
          }
          onKeyDown(e);
        }}
      />
    </FieldShell>
  );
}

export interface TextFieldProps {
  label: string;
  value: string;
  maxLength: number;
  /** Returns the cleaned value or `undefined` when invalid. */
  validate: (text: string) => string | undefined;
  errorText: string;
  hint?: ReactNode;
  placeholder?: string;
  testId?: string;
  onCommit: (value: string) => void;
}

export function TextField(props: TextFieldProps) {
  const id = useId();
  const { draft, setDraft, invalid, commit, onKeyDown } = useDraft<string>(
    props.value,
    (v) => v,
    props.validate,
    props.onCommit,
  );
  return (
    <FieldShell
      id={id}
      label={props.label}
      hint={props.hint}
      error={invalid ? props.errorText : null}
    >
      <input
        id={id}
        data-testid={props.testId}
        type="text"
        spellCheck={false}
        autoComplete="off"
        maxLength={props.maxLength}
        placeholder={props.placeholder}
        aria-invalid={invalid || undefined}
        value={draft}
        onChange={(e) => setDraft(e.currentTarget.value)}
        onBlur={commit}
        onKeyDown={onKeyDown}
      />
    </FieldShell>
  );
}

export function Toggle(props: {
  label: string;
  checked: boolean;
  hint?: ReactNode;
  testId?: string;
  onChange: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="field field-toggle">
      <input
        id={id}
        type="checkbox"
        data-testid={props.testId}
        checked={props.checked}
        onChange={(e) => props.onChange(e.currentTarget.checked)}
      />
      <label htmlFor={id}>{props.label}</label>
      {props.hint && <span className="field-hint">{props.hint}</span>}
    </div>
  );
}

/** Slider with a local draft so IPC round-trips do not make it jump. */
export function RangeField(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  testId?: string;
  onCommit: (value: number) => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState(props.value);
  useEffect(() => setDraft(props.value), [props.value]);
  return (
    <div className="field">
      <label htmlFor={id}>
        {props.label} <output>{props.format(draft)}</output>
      </label>
      <input
        id={id}
        type="range"
        data-testid={props.testId}
        min={props.min}
        max={props.max}
        step={props.step}
        value={draft}
        onChange={(e) => {
          const v = Number(e.currentTarget.value);
          if (!Number.isFinite(v)) return;
          setDraft(v);
          props.onCommit(v);
        }}
      />
    </div>
  );
}
