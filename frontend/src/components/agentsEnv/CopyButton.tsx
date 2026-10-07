import { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Button } from '../ui/Button';
import { copyToClipboard } from '../../utils/clipboard';

/** Ghost "Copy" button; the label reads "Copied" or "Copy failed" for 1.5 s after a click. */
export function CopyButton({
  text,
  label = 'Copy',
  testId,
}: {
  text: string;
  label?: string;
  testId?: string;
}): React.JSX.Element {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  const onClick = (): void => {
    void copyToClipboard(text).then((ok) => {
      setState(ok ? 'copied' : 'failed');
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(() => setState('idle'), 1500);
    });
  };

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={onClick}
      data-testid={testId}
      icon={state === 'copied' ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
    >
      {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : label}
    </Button>
  );
}
