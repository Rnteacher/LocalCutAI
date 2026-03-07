import { UIButton } from './ui.js';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  warning?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  message,
  warning,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="lc-panel w-[460px] max-w-[92vw] rounded-xl p-4 shadow-2xl">
        <h3 className="mb-2 text-sm font-semibold text-zinc-100">{title}</h3>
        <p className="mb-2 text-sm text-zinc-300">{message}</p>
        {warning && (
          <p className="mb-3 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-xs text-amber-300">
            {warning}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <UIButton onClick={onCancel}>{cancelLabel}</UIButton>
          <UIButton variant="danger" onClick={onConfirm}>
            {confirmLabel}
          </UIButton>
        </div>
      </div>
    </div>
  );
}
