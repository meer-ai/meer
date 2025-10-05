import chalk from 'chalk';
import inquirer from 'inquirer';

interface HandleCodeBlocksOptions {
  disableAutomationFlagEnv?: string;
}

const DEFAULT_DISABLE_FLAG = 'DEVAI_DISABLE_CODEBLOCK_AUTOMATION';

export async function handleCodeBlocks(aiResponse: string, options: HandleCodeBlocksOptions = {}): Promise<void> {
  if (!aiResponse?.trim()) {
    return;
  }

  const disableFlag = options.disableAutomationFlagEnv ?? DEFAULT_DISABLE_FLAG;
  if (process.env[disableFlag] === 'true') {
    console.log(chalk.gray(`\n⚙️  Code block automation disabled via ${disableFlag}.`));
    return;
  }

  // Look for code blocks in the AI response
  const codeBlockRegex = /```(\w+)?\n([\s\S]*?)```/g;
  const matches = [...aiResponse.matchAll(codeBlockRegex)];

  if (matches.length === 0) {
    return; // No code blocks found
  }

  // Check if always allow is enabled
  const alwaysAllow = process.env.DEVAI_ALWAYS_ALLOW === 'true';

  console.log(chalk.bold.blue('\n📝 Creating/updating files from AI response...\n'));

  const { writeFileSync, existsSync, mkdirSync, readFileSync } = await import('fs');
  const { join, dirname, isAbsolute } = await import('path');

  for (const match of matches) {
    const [, language, code] = match;
    let cleanCode = code.trim();

    // Try to extract filepath from comment at the top of the code block
    let filename = '';
    let filePath = '';
    const filepathMatch = cleanCode.match(/^(?:\/\/|#|<!--)\s*filepath:\s*(.+?)(?:-->)?\n/i);

    if (filepathMatch) {
      // Extract filepath from comment
      filename = filepathMatch[1].trim();
      // Remove the filepath comment from the code
      cleanCode = cleanCode.replace(/^(?:\/\/|#|<!--)\s*filepath:\s*.+?(?:-->)?\n/i, '').trim();

      if (isAbsolute(filename)) {
        filePath = filename;
      } else {
        filePath = join(process.cwd(), filename);
      }
    } else {
      // Fallback: Determine file extension and name based on language
      if (language === 'html') {
        filename = 'index.html';
      } else if (language === 'javascript' || language === 'js') {
        filename = 'app.js';
      } else if (language === 'css') {
        filename = 'style.css';
      } else if (language === 'python' || language === 'py') {
        filename = 'main.py';
      } else if (language === 'typescript' || language === 'ts') {
        filename = 'index.ts';
      } else if (language === 'json') {
        filename = 'config.json';
      } else {
        // Default to .txt for unknown languages
        filename = `code_${Date.now()}.txt`;
      }
      filePath = join(process.cwd(), filename);
    }

    // Check if file already exists
    const fileExists = existsSync(filePath);
    let existingContent = '';
    if (fileExists) {
      try {
        existingContent = readFileSync(filePath, 'utf-8');
      } catch (error) {
        existingContent = '';
      }
    }

    // Show file analysis and diff
    if (fileExists && existingContent !== cleanCode) {
      console.log(chalk.yellow(`📄 Updating existing file: ${filePath}`));
      showColoredDiff(existingContent, cleanCode);
    } else if (!fileExists) {
      console.log(chalk.green(`📄 Creating new file: ${filePath}`));
      showFilePreview(cleanCode);
    } else {
      console.log(chalk.gray(`📄 File ${filePath} unchanged`));
      continue;
    }

    // Quick confirmation for non-always-allow mode
    if (!alwaysAllow) {
      const { confirm } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'confirm',
          message: `Apply changes to ${filePath}?`,
          default: true
        }
      ]);

      if (!confirm) {
        console.log(chalk.gray(`Skipped ${filePath}`));
        continue;
      }
    }

    // Apply changes
    try {
      // Ensure directory exists
      const dir = dirname(filePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      writeFileSync(filePath, cleanCode, 'utf-8');
      console.log(chalk.green(`✅ Created/updated: ${filePath}`));
    } catch (error) {
      console.log(chalk.red(`❌ Failed to create ${filePath}:`), error);
    }
  }

  console.log(chalk.gray('\n💡 Files are ready to use!'));
}

function showColoredDiff(oldContent: string, newContent: string) {
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');

  console.log(chalk.gray('┌─ Changes:'));

  // Show first few lines of changes
  let changeCount = 0;
  const maxChanges = 8;

  for (let i = 0; i < Math.max(oldLines.length, newLines.length) && changeCount < maxChanges; i++) {
    const oldLine = oldLines[i] || '';
    const newLine = newLines[i] || '';

    if (oldLine !== newLine) {
      changeCount++;
      if (oldLine) {
        console.log(chalk.red(`- ${oldLine}`));
      }
      if (newLine) {
        console.log(chalk.green(`+ ${newLine}`));
      }
    } else if (changeCount > 0 && changeCount < 3) {
      // Show context lines
      console.log(chalk.gray(`  ${oldLine}`));
    }
  }

  if (changeCount >= maxChanges) {
    console.log(chalk.gray('  ... (more changes)'));
  }

  console.log(chalk.gray('└─'));
}

function showFilePreview(content: string) {
  const lines = content.split('\n');
  const previewLines = lines.slice(0, 5);

  console.log(chalk.gray('┌─ Preview:'));
  previewLines.forEach(line => {
    console.log(chalk.gray(`│ ${line}`));
  });

  if (lines.length > 5) {
    console.log(chalk.gray(`│ ... (${lines.length - 5} more lines)`));
  }

  console.log(chalk.gray('└─'));
}
