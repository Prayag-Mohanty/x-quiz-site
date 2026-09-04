/**
 * The few shared bits of markup. Not a design system — just enough so the
 * panels below stay readable.
 */

import { useEffect, useState, type ReactNode } from 'react';

export function Button({
  children,
  onClick,
  danger,
  disabled,
  type = 'button',
}: {
  children: ReactNode;
  onClick?: () => void;
  danger?: boolean;
  disabled?: boolean;
  type?: 'button' | 'submit';
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`rounded border px-2 py-1 text-sm disabled:opacity-40 ${
        danger
          ? 'border-red-400 text-red-700 hover:bg-red-50'
          : 'border-neutral-400 hover:bg-neutral-100'
      }`}
    >
      {children}
    </button>
  );
}

export function Panel({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="rounded border border-neutral-300 bg-white">
      <header className="flex items-center justify-between border-b border-neutral-200 px-3 py-2">
        <h2 className="text-sm font-semibold tracking-wide text-neutral-700 uppercase">{title}</h2>
        {aside}
      </header>
      <div className="p-3">{children}</div>
    </section>
  );
}

/**
 * A text input that saves when you leave it or press Enter.
 *
 * Deliberately not save-on-keystroke: every write is a round trip that refetches
 * the quiz, and the server may reject the value. Committing on blur means one
 * request per edit and one place for the error to appear.
 */
export function EditableText({
  value,
  onSave,
  placeholder,
  multiline,
  className = '',
}: {
  value: string;
  onSave: (next: string) => void;
  placeholder?: string;
  multiline?: boolean;
  className?: string;
}) {
  const [draft, setDraft] = useState(value);

  // Resync when the server sends back something different from what was typed
  // — a rejected write, or a value it normalised.
  useEffect(() => setDraft(value), [value]);

  const commit = () => {
    if (draft !== value) onSave(draft);
  };

  const shared = `w-full rounded border border-neutral-300 px-2 py-1 text-sm ${className}`;

  if (multiline) {
    return (
      <textarea
        className={`${shared} min-h-20 font-mono`}
        value={draft}
        placeholder={placeholder ?? ''}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
      />
    );
  }
  return (
    <input
      className={shared}
      value={draft}
      placeholder={placeholder ?? ''}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
      }}
    />
  );
}

/** A one-field add form. Clears itself on submit. */
export function AddForm({
  label,
  placeholder,
  onAdd,
}: {
  label: string;
  placeholder: string;
  onAdd: (value: string) => void;
}) {
  const [value, setValue] = useState('');
  return (
    <form
      className="flex gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        const trimmed = value.trim();
        if (!trimmed) return;
        onAdd(trimmed);
        setValue('');
      }}
    >
      <input
        className="flex-1 rounded border border-neutral-300 px-2 py-1 text-sm"
        value={value}
        placeholder={placeholder}
        onChange={(e) => setValue(e.target.value)}
      />
      <Button type="submit">{label}</Button>
    </form>
  );
}
