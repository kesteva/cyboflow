import { execSync as nodeExecSync, ExecSyncOptions, ExecSyncOptionsWithStringEncoding, ExecSyncOptionsWithBufferEncoding } from 'child_process';
import { getShellPath } from './shellPath';

/**
 * Extended ExecSyncOptions that includes a custom 'silent' flag
 * to suppress command execution logging
 */
export interface ExtendedExecSyncOptions extends ExecSyncOptions {
  silent?: boolean;
}

class CommandExecutor {
  execSync(command: string, options: ExecSyncOptionsWithStringEncoding & { silent?: boolean }): string;
  execSync(command: string, options?: ExecSyncOptionsWithBufferEncoding & { silent?: boolean }): Buffer;
  execSync(command: string, options?: ExtendedExecSyncOptions): string | Buffer {
    // Log the command being executed (unless silent mode requested)
    const cwd = options?.cwd || process.cwd();

    const extendedOptions = options as ExtendedExecSyncOptions;
    const silentMode = extendedOptions?.silent === true;
    
    if (!silentMode) {
      console.log(`[CommandExecutor] Executing: ${command} in ${cwd}`);
    }

    // Get enhanced shell PATH
    const shellPath = getShellPath();
    
    // Merge enhanced PATH into options (but remove our custom silent flag)
    const { silent: _silent, ...cleanOptions } = extendedOptions || {};
    const enhancedOptions = {
      ...cleanOptions,
      windowsHide: true,
      env: {
        ...process.env,
        ...cleanOptions?.env,
        PATH: shellPath
      }
    };

    try {
      const result = nodeExecSync(command, enhancedOptions as ExecSyncOptions);
      
      // Log success with a preview of the result (unless silent mode)
      if (result && !silentMode) {
        const resultStr = result.toString();
        const lines = resultStr.split('\n');
        const preview = lines[0].substring(0, 100) + 
                        (lines.length > 1 ? ` ... (${lines.length} lines)` : '');
        console.log(`[CommandExecutor] Success: ${preview}`);
      }
      
      return result;
    } catch (error: unknown) {
      // Log error (unless silent mode)
      if (!silentMode) {
        console.error(`[CommandExecutor] Failed: ${command}`);
        console.error(`[CommandExecutor] Error: ${error instanceof Error ? error.message : String(error)}`);
      }
      
      throw error;
    }
  }
}

// Export a singleton instance
export const commandExecutor = new CommandExecutor();

// Export the execSync function as a drop-in replacement
export const execSync = commandExecutor.execSync.bind(commandExecutor);