"use client";

import { useId } from "react";

interface PasswordFieldsProps {
  password: string;
  confirm: string;
  onPassword: (value: string) => void;
  onConfirm: (value: string) => void;
  passwordError?: string;
  confirmError?: string;
  disabled?: boolean;
  label?: string;
}

/** New-password pair. Values are never trimmed or normalized. */
export function PasswordFields({ password, confirm, onPassword, onConfirm, passwordError, confirmError, disabled, label = "Password" }: PasswordFieldsProps) {
  const id = useId();
  return (
    <>
      <div className="fp-row">
        <label className="fp-label" htmlFor={`${id}-password`}>{label}</label>
        <div className="fp-field">
          <input
            id={`${id}-password`}
            name="new-password"
            type="password"
            autoComplete="new-password"
            autoCapitalize="off"
            value={password}
            onChange={(event) => onPassword(event.target.value)}
            aria-invalid={passwordError ? true : undefined}
            aria-describedby={`${id}-password-hint${passwordError ? ` ${id}-password-error` : ""}`}
            disabled={disabled}
          />
          <span className="fp-hint" id={`${id}-password-hint`}>
            At least {PASSWORD_MIN_CHARACTERS} characters, up to {PASSWORD_MAX_BYTES.toLocaleString("en-US")} bytes. Spaces count. A long passphrase is best.
          </span>
          {passwordError ? <span className="fp-field-error" id={`${id}-password-error`}>{passwordError}</span> : null}
        </div>
      </div>
      <div className="fp-row">
        <label className="fp-label" htmlFor={`${id}-confirm`}>Confirm</label>
        <div className="fp-field">
          <input
            id={`${id}-confirm`}
            name="confirm-password"
            type="password"
            autoComplete="new-password"
            autoCapitalize="off"
            value={confirm}
            onChange={(event) => onConfirm(event.target.value)}
            aria-invalid={confirmError ? true : undefined}
            aria-describedby={confirmError ? `${id}-confirm-error` : undefined}
            disabled={disabled}
          />
          {confirmError ? <span className="fp-field-error" id={`${id}-confirm-error`}>{confirmError}</span> : null}
        </div>
      </div>
    </>
  );
}

/** Mirrors validateNewPassword in lib/auth/password.ts: Unicode codepoints and UTF-8 bytes. */
export const PASSWORD_MIN_CHARACTERS = 12;
export const PASSWORD_MAX_BYTES = 1024;

export function passwordErrors(password: string, confirm: string): { password?: string; confirm?: string } {
  const errors: { password?: string; confirm?: string } = {};
  if (!password) errors.password = "Choose a password.";
  else if ([...password].length < PASSWORD_MIN_CHARACTERS) errors.password = `Use at least ${PASSWORD_MIN_CHARACTERS} characters.`;
  else if (new TextEncoder().encode(password).length > PASSWORD_MAX_BYTES) {
    errors.password = `Use at most ${PASSWORD_MAX_BYTES.toLocaleString("en-US")} bytes. Some characters, such as emoji and accented letters, use more than one.`;
  }
  if (!confirm) errors.confirm = "Type the password again.";
  else if (password && confirm !== password) errors.confirm = "The two passwords do not match.";
  return errors;
}
