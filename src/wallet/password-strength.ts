export interface PasswordStrength {
  entropyBits: number;
  warnings: string[];
  suggestions: string[];
}

export function estimatePasswordStrength(pw: string): PasswordStrength {
  const warnings: string[] = [];
  const suggestions: string[] = [];
  if (!pw) return { entropyBits: 0, warnings: ['Empty password'], suggestions: ['Use a long passphrase'] };

  const length = pw.length;
  const lower = /[a-z]/.test(pw);
  const upper = /[A-Z]/.test(pw);
  const digits = /[0-9]/.test(pw);
  const symbols = /[^A-Za-z0-9]/.test(pw);

  let charsetSize = 0;
  if (lower) charsetSize += 26;
  if (upper) charsetSize += 26;
  if (digits) charsetSize += 10;
  if (symbols) charsetSize += 33;
  if (charsetSize === 0) charsetSize = 1;

  const entropyBits = length * Math.log2(charsetSize);

  if (length < 12) {
    warnings.push('Password shorter than 12 characters');
    suggestions.push('Use 12+ characters');
  }

  if (!(upper && digits && symbols)) suggestions.push('Add more variety (uppercase, digits, symbols)');
  if (/^[A-Za-z]+$/.test(pw)) warnings.push('Only letters detected');
  if (/^[0-9]+$/.test(pw)) warnings.push('Only digits detected');

  return { entropyBits: Math.round(entropyBits * 10) / 10, warnings, suggestions };
}

export function assertStrongPassword(pw: string): void {
  const est = estimatePasswordStrength(pw);
  if (est.entropyBits < 80) {
    throw new Error(`Master password too weak (entropy≈${est.entropyBits} bits). Warnings: ${est.warnings.join('; ')}`);
  }
}