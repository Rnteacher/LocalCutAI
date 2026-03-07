import type { ButtonHTMLAttributes, InputHTMLAttributes, SelectHTMLAttributes } from 'react';

function join(...parts: Array<string | undefined | false>): string {
  return parts.filter(Boolean).join(' ');
}

export function UIButton({
  className,
  variant = 'default',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'primary' | 'danger';
}) {
  return (
    <button
      {...props}
      className={join(
        'lc-btn',
        variant === 'primary' && 'lc-btn-primary',
        variant === 'danger' && 'lc-btn-danger',
        className,
      )}
    />
  );
}

export function UIInput({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={join('lc-input', className)} />;
}

export function UISelect({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={join('lc-select', className)} />;
}
