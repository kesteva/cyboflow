import React from 'react';
import { Zap, CheckCircle, GitBranch, X } from 'lucide-react';
import cyboflowWordmark from '../assets/cyboflow-wordmark.svg';
import { Modal, ModalBody, ModalFooter } from './ui/Modal';
import { Button } from './ui/Button';

interface WelcomeProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function Welcome({ isOpen, onClose }: WelcomeProps) {
  const [dontShowAgain, setDontShowAgain] = React.useState(false);
  
  React.useEffect(() => {
    // Load the preference from database when component mounts
    const loadPreference = async () => {
      if (window.electron?.invoke) {
        try {
          console.log('[Welcome] Loading hide_welcome preference...');
          const result = await window.electron.invoke('preferences:get', 'hide_welcome');
          console.log('[Welcome] Preference result:', result);
          
          if (result?.success) {
            // Handle null (preference doesn't exist) as false
            const shouldHide = result.data === 'true';
            setDontShowAgain(shouldHide);
            console.log('[Welcome] Set dontShowAgain to:', shouldHide);
          } else {
            console.error('[Welcome] Failed to load preference:', result?.error);
          }
        } catch (error) {
          console.error('[Welcome] Error loading preference:', error);
        }
      } else {
        console.warn('[Welcome] Electron invoke not available');
      }
    };
    loadPreference();
  }, []);
  
  if (!isOpen) return null;

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="lg" showCloseButton={false}>
      {/* Header with gradient. The shared Modal close button (muted
          text-text-tertiary, tuned for light surfaces) is invisible on this
          terracotta header, so it is suppressed (showCloseButton={false}) and a
          high-contrast close button is rendered here in the on-interactive color. */}
      <div className="bg-interactive p-6 text-on-interactive rounded-t-lg">
        <div className="flex items-start justify-between">
          <div>
            <img src={cyboflowWordmark} alt="Cyboflow" className="h-9 w-auto mb-2" />
            <h1 className="text-2xl font-bold">Welcome</h1>
            <p className="text-interactive-text/80">Run AI coding flows in parallel — with you in the loop</p>
          </div>
          <button
            aria-label="Close modal"
            onClick={onClose}
            className="-mr-1 -mt-1 rounded p-1 text-on-interactive/70 transition-colors hover:text-on-interactive hover:bg-white/10"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
      </div>

      <ModalBody className="max-h-96 overflow-y-auto">
          <div className="space-y-6">
            {/* Quick Start Guide */}
            <section>
              <h2 className="text-xl font-semibold text-text-primary mb-4 flex items-center">
                <Zap className="h-6 w-6 mr-2 text-status-warning" />
                Quick Start Guide
              </h2>
              
              {/* Prerequisites */}
              <div className="bg-status-warning/10 border border-status-warning/30 rounded-lg p-4 mb-4">
                <h3 className="font-semibold text-status-warning mb-2 flex items-center">
                  <CheckCircle className="h-5 w-5 mr-2" />
                  Before You Begin
                </h3>
                <ul className="space-y-2 text-status-warning/80">
                  <li className="flex items-start">
                    <span className="mr-2">•</span>
                    <span>Claude Code must be installed with credentials configured (a <strong>Max plan</strong> works best)</span>
                  </li>
                  <li className="flex items-start">
                    <span className="mr-2">•</span>
                    <span>You control how much agents can do on their own — from ask-before-edits to fully autonomous (<strong>Settings → Agent Permission Mode</strong>)</span>
                  </li>
                  <li className="flex items-start">
                    <span className="mr-2">•</span>
                    <span>Want a guided tour first? Turn on <strong>Demo Mode</strong> in Settings for a sandbox project with scripted agents</span>
                  </li>
                </ul>
              </div>

              {/* Steps */}
              <div className="space-y-4">
                <div className="flex items-start">
                  <div className="flex-shrink-0 w-8 h-8 bg-interactive rounded-full flex items-center justify-center text-on-interactive font-semibold">
                    1
                  </div>
                  <div className="ml-4 flex-1">
                    <h4 className="font-semibold text-text-primary mb-1">Create or Select a Project</h4>
                    <ul className="text-text-secondary space-y-1 text-sm">
                      <li>• Point to a <strong>new directory</strong> - Cyboflow will create it and initialize git</li>
                      <li>• Or select an <strong>existing git repository</strong></li>
                    </ul>
                  </div>
                </div>

                <div className="flex items-start">
                  <div className="flex-shrink-0 w-8 h-8 bg-interactive rounded-full flex items-center justify-center text-on-interactive font-semibold">
                    2
                  </div>
                  <div className="ml-4 flex-1">
                    <h4 className="font-semibold text-text-primary mb-1">Start a Session</h4>
                    <ul className="text-text-secondary space-y-1 text-sm">
                      <li>• Each session gets its own <strong>isolated git worktree</strong> — run several in parallel</li>
                      <li>• Chat directly in a <strong>quick session</strong>, or run a built-in flow</li>
                      <li>• <strong>Planner</strong> turns an idea into epics and tasks on the board; <strong>Sprint</strong> executes a batch of ready tasks in parallel lanes</li>
                    </ul>
                  </div>
                </div>

                <div className="flex items-start">
                  <div className="flex-shrink-0 w-8 h-8 bg-interactive rounded-full flex items-center justify-center text-on-interactive font-semibold">
                    3
                  </div>
                  <div className="ml-4 flex-1">
                    <h4 className="font-semibold text-text-primary mb-1">Stay in the Loop</h4>
                    <ul className="text-text-secondary space-y-1 text-sm">
                      <li>• Permission requests, agent questions, and findings land in the <strong>Human review</strong> queue</li>
                      <li>• Watch live <strong>flow progress</strong> and per-task <strong>sprint lanes</strong> as agents work</li>
                      <li>• Blocking items pause the run until you decide — nothing ships without you</li>
                    </ul>
                  </div>
                </div>

                <div className="flex items-start">
                  <div className="flex-shrink-0 w-8 h-8 bg-interactive rounded-full flex items-center justify-center text-on-interactive font-semibold">
                    4
                  </div>
                  <div className="ml-4 flex-1">
                    <h4 className="font-semibold text-text-primary mb-1">Ship the Result</h4>
                    <ul className="text-text-secondary space-y-1 text-sm">
                      <li>• Review the session's changes in the <strong>Diff panel</strong> and file explorer</li>
                      <li>• <strong>Merge back to main</strong> or <strong>open a PR</strong> when you're happy — merging a sprint moves its tasks to Done</li>
                      <li>• Not happy? <strong>Dismiss</strong> the session and nothing touches your main branch</li>
                    </ul>
                  </div>
                </div>
              </div>
            </section>

            {/* Key Features */}
            <section className="border-t pt-6">
              <h3 className="font-semibold text-text-primary mb-3 flex items-center">
                <GitBranch className="h-5 w-5 mr-2" />
                Key Features
              </h3>
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div className="flex items-center text-text-secondary">
                  <CheckCircle className="h-4 w-4 mr-2 text-status-success flex-shrink-0" />
                  <span>Parallel sessions in isolated git worktrees</span>
                </div>
                <div className="flex items-center text-text-secondary">
                  <CheckCircle className="h-4 w-4 mr-2 text-status-success flex-shrink-0" />
                  <span>Built-in Planner &amp; Sprint flows</span>
                </div>
                <div className="flex items-center text-text-secondary">
                  <CheckCircle className="h-4 w-4 mr-2 text-status-success flex-shrink-0" />
                  <span>Idea → epic → task board</span>
                </div>
                <div className="flex items-center text-text-secondary">
                  <CheckCircle className="h-4 w-4 mr-2 text-status-success flex-shrink-0" />
                  <span>Human review queue for approvals &amp; questions</span>
                </div>
                <div className="flex items-center text-text-secondary">
                  <CheckCircle className="h-4 w-4 mr-2 text-status-success flex-shrink-0" />
                  <span>Configurable agent permission modes</span>
                </div>
                <div className="flex items-center text-text-secondary">
                  <CheckCircle className="h-4 w-4 mr-2 text-status-success flex-shrink-0" />
                  <span>Merge or PR back to main when you approve</span>
                </div>
              </div>
            </section>
          </div>
      </ModalBody>
        
      <ModalFooter className="flex justify-between items-center">
        <Button
          onClick={async () => {
            const newValue = !dontShowAgain;
            console.log('[Welcome Debug] Don\'t show again clicked:', newValue);
            setDontShowAgain(newValue);
            if (window.electron?.invoke) {
              try {
                const result = await window.electron.invoke('preferences:set', 'hide_welcome', newValue ? 'true' : 'false');
                if (result?.success) {
                  console.log('[Welcome Debug] Successfully set hide_welcome preference to', newValue);
                } else {
                  console.error('[Welcome Debug] Failed to set preference:', result?.error);
                }
              } catch (error) {
                console.error('[Welcome Debug] Error setting preference:', error);
              }
            }
            // Close the popup when don't show again is clicked and set to true
            if (newValue) {
              onClose();
            }
          }}
          variant={dontShowAgain ? "secondary" : "ghost"}
          size="sm"
        >
          {dontShowAgain ? "Will hide on next launch" : "Don't show this again"}
        </Button>
        <Button
          onClick={onClose}
          variant="primary"
        >
          Get Started
        </Button>
      </ModalFooter>
    </Modal>
  );
}