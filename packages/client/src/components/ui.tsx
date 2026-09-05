/**
 * The few shared bits of markup. Not a design system — just enough so the
 * panels below stay readable.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';

import { toggleMark, type Mark } from '../richtext.js';

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
  formatting,
  className = '',
}: {
  value: string;
  onSave: (next: string) => void;
  placeholder?: string;
  multiline?: boolean;
  /** Show bold/italic/underline controls. Multiline fields only. */
  formatting?: boolean;
  className?: string;
}) {
  const [draft, setDraft] = useState(value);
  const box = useRef<HTMLTextAreaElement>(null);

  // Resync when the server sends back something different from what was typed
  // — a rejected write, or a value it normalised.
  useEffect(() => setDraft(value), [value]);

  const commit = () => {
    if (draft !== value) onSave(draft);
  };

  const shared = `w-full rounded border border-neutral-300 px-2 py-1 text-sm ${className}`;

  if (multiline) {
    return (
      <div>
        {formatting && (
          <FormatBar
            textarea={box}
            value={draft}
            onChange={(next, start, end) => {
              setDraft(next);
              // Restore the selection after React has written the new value,
              // or the caret lands at the end and the next press wraps the
              // wrong thing.
              requestAnimationFrame(() => {
                const el = box.current;
                if (!el) return;
                el.focus();
                el.setSelectionRange(start, end);
              });
            }}
            onCommit={(next) => {
              if (next !== value) onSave(next);
            }}
          />
        )}
        <textarea
          ref={box}
          className={`${shared} min-h-20 font-mono`}
          value={draft}
          placeholder={placeholder ?? ''}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
        />
      </div>
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

/**
 * Bold, italic, underline.
 *
 * The markers are plain text in the stored question — `**bold**` — so this is
 * a convenience over typing them, not a different representation. That matters:
 * a question written before these buttons existed is still a valid question,
 * and one written with them is still readable in psql.
 *
 * Wraps whatever is selected, and toggles off if it is already wrapped. With
 * nothing selected it inserts the pair for you to type between.
 */
function FormatBar({
  textarea,
  value,
  onChange,
  onCommit,
}: {
  textarea: React.RefObject<HTMLTextAreaElement>;
  value: string;
  onChange: (next: string, start: number, end: number) => void;
  onCommit: (next: string) => void;
}) {
  const apply = (mark: Mark) => {
    const el = textarea.current;
    if (!el) return;
    const result = toggleMark(value, el.selectionStart, el.selectionEnd, mark);
    onChange(result.text, result.start, result.end);
    onCommit(result.text);
  };

  const buttons: { mark: Mark; label: string; className: string; title: string }[] = [
    { mark: 'bold', label: 'B', className: 'font-bold', title: 'Bold  **like this**' },
    { mark: 'italic', label: 'I', className: 'italic', title: 'Italic  *like this*' },
    { mark: 'underline', label: 'U', className: 'underline', title: 'Underline  _like this_' },
  ];

  return (
    <div className="mb-1 flex gap-1">
      {buttons.map((b) => (
        <button
          key={b.mark}
          type="button"
          // onMouseDown, not onClick: clicking a button blurs the textarea and
          // takes the selection with it, and the selection is the whole input.
          onMouseDown={(e) => {
            e.preventDefault();
            apply(b.mark);
          }}
          title={b.title}
          className={`h-7 w-7 rounded border border-neutral-300 text-sm text-neutral-700 hover:bg-neutral-100 ${b.className}`}
        >
          {b.label}
        </button>
      ))}
    </div>
  );
}
