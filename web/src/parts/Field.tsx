import { forwardRef, useId, type InputHTMLAttributes, type ReactNode, type Ref } from 'react';
import { cx } from './classes';
import { Eyebrow } from './Eyebrow';

export interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  size?: 'sm' | 'md';
  /** A visible label. Without one, pass `aria-label`. */
  label?: string;
  /** A short note inside the box at the right, such as a key or a unit. */
  hint?: ReactNode;
  /** The reason the value is not accepted, said under the box. */
  invalid?: string;
  /** Saving: the box dims and the value cannot be edited. */
  busy?: boolean;
  /** A textarea that grows with its text. */
  multiline?: boolean;
  rows?: number;
}

/** A text field: an optional label above, a box with the input and a hint, and the reason it is invalid below. */
export const Field = forwardRef<HTMLInputElement | HTMLTextAreaElement, FieldProps>(function Field(
  { size = 'md', label, hint, invalid, busy, multiline, rows, id, className, readOnly, 'aria-describedby': describedBy, ...rest },
  ref,
) {
  const auto = useId();
  const inputId = id ?? `${auto}-input`;
  const hintId = `${auto}-hint`;
  const reasonId = `${auto}-reason`;
  const described = [describedBy, hint ? hintId : undefined, invalid ? reasonId : undefined].filter(Boolean).join(' ') || undefined;
  const shared = {
    id: inputId,
    className: 'p-field-input',
    'aria-invalid': invalid ? true : undefined,
    'aria-describedby': described,
    readOnly: busy || readOnly,
  };
  return (
    <div className={cx('p-field', className)} data-size={size} data-invalid={invalid ? '' : undefined} data-busy={busy || undefined}>
      {label && (
        <Eyebrow as="label" htmlFor={inputId}>
          {label}
        </Eyebrow>
      )}
      <div className="p-field-box">
        {multiline ? (
          <textarea ref={ref as Ref<HTMLTextAreaElement>} rows={rows ?? 2} {...(rest as object)} {...shared} />
        ) : (
          <input ref={ref as Ref<HTMLInputElement>} {...rest} {...shared} />
        )}
        {hint && (
          <span id={hintId} className="p-field-hint">
            {hint}
          </span>
        )}
      </div>
      {invalid && (
        <span id={reasonId} className="p-field-reason">
          {invalid}
        </span>
      )}
    </div>
  );
});
