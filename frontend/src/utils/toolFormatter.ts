import type { ClaudeJsonMessage, MessageContent, TextContent } from '../types/session';
import type { ToolResultBlock } from '../../../shared/types/claudeStream';
import { extractToolResultText } from '../../../shared/utils/extractToolResultText';

// Simple fallback formatter for unknown message types
function formatJsonForOutput(jsonMessage: ClaudeJsonMessage): string {
  const timestamp = jsonMessage.timestamp || new Date().toISOString();
  const time = new Date(timestamp).toLocaleTimeString();
  
  // Handle system messages
  if (jsonMessage.type === 'system') {
    return `\r\n\x1b[36m[${time}]\x1b[0m \x1b[90m⚙️  System: ${jsonMessage.subtype || 'info'}\x1b[0m\r\n\r\n`;
  }
  
  // Handle result messages
  if (jsonMessage.type === 'result') {
    const status = jsonMessage.is_error ? '❌ Error' : '✅ Success';
    // Removed cost display
    return `\r\n\x1b[36m[${time}]\x1b[0m \x1b[90m${status}\x1b[0m\r\n\r\n`;
  }
  
  // Default formatting
  return `\r\n\x1b[36m[${time}]\x1b[0m \x1b[90m${JSON.stringify(jsonMessage, null, 2)}\x1b[0m\r\n\r\n`;
}

interface ToolCall {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface PendingToolCall {
  call: ToolCall;
  timestamp: string;
}

// Store pending tool calls to match with their results
const pendingToolCalls = new Map<string, PendingToolCall>();

/**
 * Recursively filter out base64 data from any object structure
 */
function filterBase64Data(obj: unknown): unknown {
  if (obj === null || obj === undefined) {
    return obj;
  }

  // Handle arrays
  if (Array.isArray(obj)) {
    return obj.map(item => filterBase64Data(item));
  }

  // Handle objects
  if (typeof obj === 'object' && obj !== null && !Array.isArray(obj)) {
    const filtered: Record<string, unknown> = {};
    const objRecord = obj as Record<string, unknown>;
    
    for (const key in objRecord) {
      if (Object.prototype.hasOwnProperty.call(objRecord, key)) {
        // Check if this is a base64 source object
        const sourceObj = objRecord[key] as Record<string, unknown>;
        if (key === 'source' && 
            sourceObj && 
            typeof sourceObj === 'object' && 
            sourceObj.type === 'base64' && 
            sourceObj.data) {
          // Replace base64 data with placeholder
          filtered[key] = {
            ...sourceObj,
            data: '[Base64 data filtered]'
          };
        } else {
          // Recursively filter nested objects
          filtered[key] = filterBase64Data(objRecord[key]);
        }
      }
    }
    
    return filtered;
  }

  // Return primitive values as-is
  return obj;
}

/**
 * Convert absolute file paths to relative paths
 */
function makePathsRelative(content: unknown): string {
  // Handle non-string content
  let stringContent: string;
  if (typeof content !== 'string') {
    if (content === null || content === undefined) {
      return '';
    }
    // Convert to string if it's an object or array
    stringContent = typeof content === 'object' ? JSON.stringify(content, null, 2) : String(content);
  } else {
    stringContent = content;
  }
  
  // Match common file path patterns
  const pathRegex = /([\\/](?:Users|home|var|tmp|mnt|opt)[\\/][^\\s\\n]+)/g;
  
  return stringContent.replace(pathRegex, (match: string) => {
    try {
      // Find the worktree path in the match
      const worktreeMatch = match.match(/worktrees[\\/][^\\/]+/);
      if (worktreeMatch) {
        // Extract everything after the worktree name
        const afterWorktree = match.substring(match.indexOf(worktreeMatch[0]) + worktreeMatch[0].length);
        return afterWorktree;
      }
      
      return match;
    } catch {
      return match;
    }
  });
}

/**
 * Helper to safely get string property from tool input
 */
function getStringProp(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Helper to safely get number property from tool input
 */
function getNumberProp(input: Record<string, unknown>, key: string): number | undefined {
  const value = input[key];
  return typeof value === 'number' ? value : undefined;
}

/**
 * Helper to safely get array property from tool input
 */
function getArrayProp(input: Record<string, unknown>, key: string): unknown[] | undefined {
  const value = input[key];
  return Array.isArray(value) ? value : undefined;
}

/**
 * Format tool call and response as a unified display
 */
export function formatToolInteraction(
  toolCall: ToolCall,
  toolResult: ToolResultBlock | null,
  callTimestamp: string,
  resultTimestamp?: string
): string {
  const timestamp = new Date(callTimestamp).toLocaleTimeString();
  
  // Format the tool call header
  let output = `\r\n\x1b[36m[${timestamp}]\x1b[0m \x1b[1m\x1b[33m🔧 Tool: ${toolCall.name}\x1b[0m\r\n`;
  
  // Format parameters based on tool type
  if (toolCall.input && Object.keys(toolCall.input).length > 0) {
    output += `\x1b[90m┌─ Parameters:\x1b[0m\r\n`;
    
    // Special formatting for common tools
    const pattern = getStringProp(toolCall.input, 'pattern');
    if (toolCall.name === 'Grep' && pattern) {
      output += `\x1b[90m│  Pattern: "${pattern}"\x1b[0m\r\n`;
      const path = getStringProp(toolCall.input, 'path');
      if (path) {
        output += `\x1b[90m│  Path: ${makePathsRelative(path)}\x1b[0m\r\n`;
      }
      const include = getStringProp(toolCall.input, 'include');
      if (include) {
        output += `\x1b[90m│  Include: ${include}\x1b[0m\r\n`;
      }
    } else if (toolCall.name === 'Read') {
      const filePath = getStringProp(toolCall.input, 'file_path');
      if (filePath) {
        output += `\x1b[90m│  File: ${makePathsRelative(filePath)}\x1b[0m\r\n`;
        const offset = getNumberProp(toolCall.input, 'offset');
        if (offset) {
          const limit = getNumberProp(toolCall.input, 'limit') || 2000;
          output += `\x1b[90m│  Lines: ${offset}-${offset + limit}\x1b[0m\r\n`;
        }
      }
    } else if (toolCall.name === 'Edit') {
      const filePath = getStringProp(toolCall.input, 'file_path');
      if (filePath) {
        output += `\x1b[90m│  File: ${makePathsRelative(filePath)}\x1b[0m\r\n`;
      }
    } else if (toolCall.name === 'Bash') {
      const command = getStringProp(toolCall.input, 'command');
      if (command) {
        output += `\x1b[90m│  $ ${command}\x1b[0m\r\n`;
      }
    } else if (toolCall.name === 'TodoWrite') {
      const todos = getArrayProp(toolCall.input, 'todos');
      if (todos) {
        output += `\x1b[90m│  Tasks updated:\x1b[0m\r\n`;
        todos.forEach((todo) => {
          if (todo && typeof todo === 'object') {
            const todoObj = todo as { status?: string; content?: string };
            const status = todoObj.status === 'completed' ? '✓' : todoObj.status === 'in_progress' ? '→' : '○';
            const statusColor = todoObj.status === 'completed' ? '\x1b[32m' : todoObj.status === 'in_progress' ? '\x1b[33m' : '\x1b[90m';
            output += `\x1b[90m│    ${statusColor}${status}\x1b[0m ${todoObj.content || ''}\x1b[0m\r\n`;
          }
        });
      }
    } else if (toolCall.name === 'Write') {
      const filePath = getStringProp(toolCall.input, 'file_path');
      if (filePath) {
        output += `\x1b[90m│  File: ${makePathsRelative(filePath)}\x1b[0m\r\n`;
        const content = getStringProp(toolCall.input, 'content');
        const lines = content ? content.split('\n') : [];
        output += `\x1b[90m│  Size: ${lines.length} lines\x1b[0m\r\n`;
      }
    } else if (toolCall.name === 'Glob') {
      const pattern = getStringProp(toolCall.input, 'pattern');
      if (pattern) {
        output += `\x1b[90m│  Pattern: ${pattern}\x1b[0m\r\n`;
        const path = getStringProp(toolCall.input, 'path');
        if (path) {
          output += `\x1b[90m│  Path: ${makePathsRelative(path)}\x1b[0m\r\n`;
        }
      }
    } else if (toolCall.name === 'MultiEdit') {
      const filePath = getStringProp(toolCall.input, 'file_path');
      if (filePath) {
        output += `\x1b[90m│  File: ${makePathsRelative(filePath)}\x1b[0m\r\n`;
        const edits = getArrayProp(toolCall.input, 'edits');
        output += `\x1b[90m│  Edits: ${edits?.length || 0} changes\x1b[0m\r\n`;
      }
    } else if (toolCall.name === 'Task') {
      const prompt = getStringProp(toolCall.input, 'prompt');
      if (prompt) {
        const truncated = prompt.length > 100 ? prompt.substring(0, 100) + '...' : prompt;
        const description = getStringProp(toolCall.input, 'description') || 'Task';
        output += `\x1b[90m│  Description: ${description}\x1b[0m\r\n`;
        output += `\x1b[90m│  Prompt: ${truncated}\x1b[0m\r\n`;
      }
    } else if (toolCall.name === 'LS') {
      const path = getStringProp(toolCall.input, 'path');
      if (path) {
        output += `\x1b[90m│  Path: ${makePathsRelative(path)}\x1b[0m\r\n`;
        const ignore = getArrayProp(toolCall.input, 'ignore');
        if (ignore && ignore.length > 0) {
          const ignoreStrings = ignore.filter(item => typeof item === 'string') as string[];
          if (ignoreStrings.length > 0) {
            output += `\x1b[90m│  Ignoring: ${ignoreStrings.join(', ')}\x1b[0m\r\n`;
          }
        }
      }
    } else if (toolCall.name === 'TodoRead') {
      output += `\x1b[90m│  Reading current task list...\x1b[0m\r\n`;
    } else {
      // Generic parameter display
      const paramStr = JSON.stringify(toolCall.input, null, 2);
      const lines = paramStr.split('\n');
      const maxLines = 8;
      
      lines.slice(0, maxLines).forEach(line => {
        output += `\x1b[90m│  ${line}\x1b[0m\r\n`;
      });
      
      if (lines.length > maxLines) {
        output += `\x1b[90m│  ... (${lines.length - maxLines} more lines)\x1b[0m\r\n`;
      }
    }
  }
  
  // Add the result if available
  if (toolResult) {
    const resultTime = resultTimestamp ? ` (${new Date(resultTimestamp).toLocaleTimeString()})` : '';
    output += `\x1b[90m├─ Result${resultTime}:\x1b[0m\r\n`;
    
    if (toolResult.content) {
      const resultText = extractToolResultText(toolResult.content);
      // Check if this is an image read result
      let isImageResult = false;
      if (toolCall.name === 'Read' && toolCall.input.file_path) {
        try {
          // Check if the result is a JSON array with image data
          const parsed = JSON.parse(resultText);
          if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].type === 'image') {
            isImageResult = true;
            // Display a friendly message instead of the base64 data
            output += `\x1b[90m│  \x1b[0m\x1b[37m[Image displayed to Claude Code]\x1b[0m\r\n`;
            output += `\x1b[90m│  \x1b[0m\x1b[90mFile: ${makePathsRelative(toolCall.input.file_path)}\x1b[0m\r\n`;
            if (parsed[0].source?.data) {
              const dataLength = parsed[0].source.data.length;
              const sizeKB = Math.round(dataLength * 0.75 / 1024); // Approximate base64 to bytes
              output += `\x1b[90m│  \x1b[0m\x1b[90mSize: ~${sizeKB} KB\x1b[0m\r\n`;
            }
          }
        } catch {
          // Not JSON or not an image, proceed with normal handling
        }
      }

      if (!isImageResult) {
        // Apply relative paths to the result content
        const processedContent = makePathsRelative(resultText);
        const lines = processedContent.split('\n');
      // Show more lines for errors to ensure important information isn't hidden
      const isError = toolCall.name === 'Bash' && (
        resultText.includes('error:') ||
        resultText.includes('Error:') ||
        resultText.includes('ERROR') ||
        resultText.includes('fatal:') ||
        resultText.includes('Command failed') ||
        resultText.includes('aborted')
      );
      const maxLines = isError ? 30 : 15;
      
      // Special handling for file listings
      if (toolCall.name === 'Grep' && lines[0]?.startsWith('Found')) {
        output += `\x1b[37m│  ${lines[0]}\x1b[0m\r\n`;
        
        // Show file paths with better formatting
        lines.slice(1, Math.min(lines.length, maxLines)).forEach(line => {
          if (line.trim()) {
            output += `\x1b[90m│  \x1b[0m\x1b[37m• ${line.trim()}\x1b[0m\r\n`;
          }
        });
        
        if (lines.length > maxLines) {
          output += `\x1b[90m│  ... (${lines.length - maxLines} more files)\x1b[0m\r\n`;
        }
      } else if (toolCall.name === 'Glob' && lines[0]?.startsWith('Found')) {
        output += `\x1b[37m│  ${lines[0]}\x1b[0m\r\n`;
        
        // Show file paths with better formatting
        lines.slice(1, Math.min(lines.length, maxLines)).forEach(line => {
          if (line.trim()) {
            output += `\x1b[90m│  \x1b[0m\x1b[37m• ${line.trim()}\x1b[0m\r\n`;
          }
        });
        
        if (lines.length > maxLines) {
          output += `\x1b[90m│  ... (${lines.length - maxLines} more files)\x1b[0m\r\n`;
        }
      } else if (toolCall.name === 'TodoRead' && lines.length > 0) {
        output += `\x1b[37m│  Current Tasks:\x1b[0m\r\n`;
        lines.forEach(line => {
          if (line.includes('✓') || line.includes('completed')) {
            output += `\x1b[90m│  \x1b[32m${line}\x1b[0m\r\n`;
          } else if (line.includes('→') || line.includes('in_progress')) {
            output += `\x1b[90m│  \x1b[33m${line}\x1b[0m\r\n`;
          } else {
            output += `\x1b[90m│  \x1b[37m${line}\x1b[0m\r\n`;
          }
        });
      } else if (toolCall.name === 'Task') {
        // Task tool results are usually longer, show more lines
        const taskMaxLines = 25;
        lines.slice(0, taskMaxLines).forEach(line => {
          output += `\x1b[90m│  \x1b[37m${line}\x1b[0m\r\n`;
        });
        if (lines.length > taskMaxLines) {
          output += `\x1b[90m│  ... (${lines.length - taskMaxLines} more lines)\x1b[0m\r\n`;
        }
      } else {
        // Generic result display
        // Check if this is an error from a Bash command
        const isGitError = toolCall.name === 'Bash' && 
          lines.some(line => 
            line.includes('error:') || 
            line.includes('Error:') || 
            line.includes('ERROR') ||
            line.includes('fatal:') ||
            line.includes('Command failed') ||
            line.includes('aborted')
          );
        
        lines.slice(0, maxLines).forEach(line => {
          // Use red color for error lines, white for normal output
          let lineColor = '\x1b[37m'; // Default white
          
          if (isGitError) {
            // For git/bash errors, highlight specific error patterns
            if (line.includes('error:') || 
                line.includes('Error:') || 
                line.includes('ERROR') ||
                line.includes('fatal:') ||
                line.includes('Command failed') ||
                line.includes('aborted')) {
              lineColor = '\x1b[91m'; // Bright red for errors
            } else if (line.includes('warning:') || 
                       line.includes('Warning:') ||
                       line.includes('hint:')) {
              lineColor = '\x1b[93m'; // Yellow for warnings/hints
            }
          }
          
          output += `\x1b[90m│  \x1b[0m${lineColor}${line}\x1b[0m\r\n`;
        });
        
        if (lines.length > maxLines) {
          output += `\x1b[90m│  ... (${lines.length - maxLines} more lines)\x1b[0m\r\n`;
        }
      }
      } // Close the !isImageResult block
    } else {
      output += `\x1b[90m│  \x1b[0m\x1b[37m(empty result)\x1b[0m\r\n`;
    }
  } else {
    // Tool call is pending
    output += `\x1b[90m└─ \x1b[33m⏳ Executing...\x1b[0m\r\n`;
  }
  
  if (toolResult) {
    // Check if this was an error result
    const resultText2 = toolResult ? extractToolResultText(toolResult.content) : '';
    const isError = toolCall.name === 'Bash' && toolResult.content && (
      resultText2.includes('error:') ||
      resultText2.includes('Error:') ||
      resultText2.includes('ERROR') ||
      resultText2.includes('fatal:') ||
      resultText2.includes('Command failed') ||
      resultText2.includes('aborted')
    );

    if (isError) {
      output += `\x1b[90m└─ \x1b[91m✗ Failed\x1b[0m\r\n`;
    } else {
      output += `\x1b[90m└─ ✓ Complete\x1b[0m\r\n`;
    }
  }
  
  return output + '\r\n';
}

/**
 * Enhanced JSON to output formatter that unifies tool calls and responses
 */
export function formatJsonForOutputEnhanced(jsonMessage: ClaudeJsonMessage): string {
  const timestamp = jsonMessage.timestamp || new Date().toISOString();
  
  // Handle tool calls from assistant
  if (jsonMessage.type === 'assistant' && jsonMessage.message?.content) {
    const content = jsonMessage.message.content;
    
    if (Array.isArray(content)) {
      const toolUses = content.filter((item: MessageContent) => item.type === 'tool_use') as ToolCall[];
      
      if (toolUses.length > 0) {
        // Store tool calls for later matching
        toolUses.forEach((toolUse: ToolCall) => {
          pendingToolCalls.set(toolUse.id, {
            call: toolUse,
            timestamp
          });
        });
        
        // Format each tool call
        return toolUses
          .map((toolUse: ToolCall) => 
            formatToolInteraction(toolUse, null, timestamp)
          )
          .join('');
      }
      
      // Handle regular text content
      const textContent = content
        .filter((item: MessageContent) => item.type === 'text')
        .map((item: TextContent) => item.text)
        .join('\n\n');
      
      if (textContent) {
        const time = new Date(timestamp).toLocaleTimeString();
        return `\r\n\x1b[36m[${time}]\x1b[0m \x1b[1m\x1b[35m🤖 Assistant\x1b[0m\r\n` +
               `\x1b[37m${textContent}\x1b[0m\r\n\r\n`;
      }
    }
  }
  
  // Handle tool results from user
  if (jsonMessage.type === 'user' && jsonMessage.message?.content) {
    const content = jsonMessage.message.content;
    
    if (Array.isArray(content)) {
      const toolResults = content.filter((item: MessageContent) => item.type === 'tool_result') as ToolResultBlock[];
      
      if (toolResults.length > 0) {
        // Match results with pending calls and format them
        return toolResults
          .map((result: ToolResultBlock) => {
            const pending = pendingToolCalls.get(result.tool_use_id);

            if (pending) {
              pendingToolCalls.delete(result.tool_use_id);
              return formatToolInteraction(
                pending.call,
                result,
                pending.timestamp,
                timestamp
              );
            }

            // Orphaned tool result — extract text first, then filter base64, then relativize paths
            const time = new Date(timestamp).toLocaleTimeString();

            // Filter out any base64 data from the extracted text
            const filteredContent = filterBase64Data(extractToolResultText(result.content));

            // Then convert to string for display
            let contentStr: string;
            if (typeof filteredContent === 'string') {
              contentStr = makePathsRelative(filteredContent);
            } else if (filteredContent !== null && filteredContent !== undefined) {
              // Convert filtered object/array to string
              contentStr = makePathsRelative(JSON.stringify(filteredContent, null, 2));
            } else {
              contentStr = '';
            }

            return `\r\n\x1b[36m[${time}]\x1b[0m \x1b[90m📥 Tool Result [${result.tool_use_id}]\x1b[0m\r\n` +
                   `\x1b[37m${contentStr}\x1b[0m\r\n\r\n`;
          })
          .join('');
      }
      
      // Handle regular text content from user
      const textContent = content
        .filter((item: MessageContent) => item.type === 'text')
        .map((item: TextContent) => item.text)
        .join(' ');
      
      if (textContent) {
        const time = new Date(timestamp).toLocaleTimeString();
        // Make user prompts more prominent with bright green background and bold text
        return `\r\n\x1b[36m[${time}]\x1b[0m \x1b[1m\x1b[42m\x1b[30m 👤 USER PROMPT \x1b[0m\r\n` +
               `\x1b[1m\x1b[92m${textContent}\x1b[0m\r\n` +
               `\x1b[90m${'─'.repeat(80)}\x1b[0m\r\n\r\n`;
      }
    }
  }
  
  // Fall back to original formatter for other message types
  return formatJsonForOutput(jsonMessage);
}