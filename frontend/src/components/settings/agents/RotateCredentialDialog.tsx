import { useEffect, useState } from 'react';
import { Button } from '../../ui/Button';
import { Input } from '../../ui/Input';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '../../ui/Modal';
import { trpc } from '../../../trpc/client';
import { errorText } from '../../../utils/errorText';
import { failureCopy } from '../../agentsEnv/agentsVocabulary';
import type { CredentialViewT } from '../../agentsEnv/types';

/**
 * Replace a stored vendor key. The new secret lives only in this component's state: it is cleared on close
 * and unmount, never logged, and never copied into an error message.
 */
export function RotateCredentialDialog({
  credential,
  isOpen,
  onClose,
  onRotated,
}: {
  credential: CredentialViewT;
  isOpen: boolean;
  onClose: () => void;
  onRotated: () => void;
}): React.JSX.Element | null {
  const [secret, setSecret] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) {
      setSecret('');
      setError(null);
    }
  }, [isOpen]);

  const save = async (): Promise<void> => {
    if (secret === '' || saving) return;
    setSaving(true);
    setError(null);
    try {
      const res = await trpc.cyboflow.persistentAgents.rotateCredential.mutate({ id: credential.id, secret });
      if (res.ok) {
        setSecret('');
        onRotated();
        onClose();
      } else if (res.error === 'not_found') {
        setError('This key no longer exists.');
        onRotated();
      } else {
        setError(failureCopy(res).copy);
      }
    } catch (e) {
      setError(errorText(e) ?? 'Something went wrong. Try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="sm">
      <ModalHeader title={`Rotate ${credential.label}`} />
      <ModalBody>
        <p className="mb-3 text-[12px] text-text-secondary">
          Paste the new key. It replaces the stored one; connections, threads and their history stay as they are.
        </p>
        <Input
          data-testid="credential-secret-input"
          type="password"
          autoComplete="off"
          spellCheck={false}
          fullWidth
          aria-label="New key"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          error={error ?? undefined}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void save();
            }
          }}
        />
      </ModalBody>
      <ModalFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          data-testid="credential-rotate-save"
          loading={saving}
          disabled={secret === ''}
          onClick={() => void save()}
        >
          Save
        </Button>
      </ModalFooter>
    </Modal>
  );
}
