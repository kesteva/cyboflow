import { useEffect, useState } from 'react';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '../ui/Modal';
import { Input } from '../ui/Input';
import { Button } from '../ui/Button';
import { useHostsStore } from '../../stores/hostsStore';
import { HOST_LABEL_MAX, SSH_TARGET_RE, type HostView } from '../../../../shared/types/hosts';

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;

export function validateEnvironmentName(raw: string): string | null {
  const name = raw.trim();
  if (name === '') return 'Enter a name.';
  if (name.length > HOST_LABEL_MAX) return `Use ${HOST_LABEL_MAX} characters or fewer.`;
  if (CONTROL_CHARS_RE.test(name)) return 'Remove control characters.';
  return null;
}

export function validateSshTarget(raw: string): string | null {
  const target = raw.trim();
  if (target === '') return 'Enter an SSH target.';
  if (!SSH_TARGET_RE.test(target)) return 'Use an ssh config alias or user@host.';
  return null;
}

/** Add an SSH environment, or edit one when `host` is given. */
export function AddEnvironmentDialog({
  isOpen,
  onClose,
  host = null,
}: {
  isOpen: boolean;
  onClose: () => void;
  host?: HostView | null;
}): React.JSX.Element | null {
  const add = useHostsStore((s) => s.add);
  const update = useHostsStore((s) => s.update);
  const [name, setName] = useState('');
  const [target, setTarget] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setName(host?.label ?? '');
    setTarget(host?.sshTarget ?? '');
    setTouched(false);
    setBusy(false);
    setFailure(null);
  }, [isOpen, host]);

  const nameError = validateEnvironmentName(name);
  const targetError = validateSshTarget(target);
  const invalid = nameError !== null || targetError !== null;

  const submit = async (): Promise<void> => {
    setTouched(true);
    if (invalid || busy) return;
    setBusy(true);
    setFailure(null);
    const label = name.trim();
    const sshTarget = target.trim();
    const res = host
      ? await update(host.id, {
          ...(label !== host.label ? { label } : {}),
          ...(sshTarget !== host.sshTarget ? { sshTarget } : {}),
        })
      : await add({ label, sshTarget });
    setBusy(false);
    if (res.ok) onClose();
    else setFailure(res.message);
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="md">
      <div data-testid="add-environment-dialog" className="flex min-h-0 flex-1 flex-col">
        <ModalHeader title={host ? 'Edit environment' : 'Add environment'} />
        <ModalBody>
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <Input
              data-testid="add-environment-name"
              label="Name"
              fullWidth
              value={name}
              maxLength={HOST_LABEL_MAX}
              placeholder="Build box"
              onChange={(e) => setName(e.target.value)}
              error={touched ? (nameError ?? undefined) : undefined}
              helperText="Shown on runs and sessions that use this machine."
            />
            <Input
              data-testid="add-environment-target"
              label="SSH target"
              fullWidth
              value={target}
              placeholder="build-box or user@host"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              onChange={(e) => setTarget(e.target.value)}
              error={touched ? (targetError ?? undefined) : undefined}
              helperText="An ~/.ssh/config alias or user@host. cyboflow uses your ssh config and ssh-agent; it never stores SSH keys."
            />
            {failure !== null && (
              <div role="alert" data-testid="add-environment-failure" className="text-[12px] text-status-error">
                {failure}
              </div>
            )}
          </form>
        </ModalBody>
        <ModalFooter>
          <Button variant="ghost" data-testid="add-environment-cancel" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            data-testid="add-environment-submit"
            loading={busy}
            disabled={busy || (touched && invalid)}
            onClick={() => void submit()}
          >
            {host ? 'Save' : 'Add environment'}
          </Button>
        </ModalFooter>
      </div>
    </Modal>
  );
}
