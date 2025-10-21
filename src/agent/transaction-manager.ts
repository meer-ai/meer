import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import chalk from 'chalk';
import { logVerbose } from '../logger.js';

export class TransactionManager {
  private checkpointId: string | null = null;
  private isGitRepo: boolean;

  constructor(private cwd: string) {
    // Check if this is a git repository
    this.isGitRepo = existsSync(join(this.cwd, '.git'));
  }

  /**
   * Create a git stash checkpoint before making changes
   */
  async createCheckpoint(name: string): Promise<void> {
    if (!this.isGitRepo) {
      logVerbose(chalk.yellow('⚠️ Not a git repository, skipping checkpoint'));
      return;
    }

    try {
      // Check if there are any changes to stash
      const status = execSync('git status --porcelain', {
        cwd: this.cwd,
        encoding: 'utf-8',
        stdio: 'pipe',
      });

      // If no changes, no need to create checkpoint
      if (!status.trim()) {
        logVerbose(chalk.gray('ℹ️ No changes to checkpoint'));
        return;
      }

      // Stash current changes with a unique identifier
      const timestamp = Date.now();
      const stashMsg = `meer-checkpoint-${name}-${timestamp}`;

      execSync(`git stash push -u -m "${stashMsg}"`, {
        cwd: this.cwd,
        stdio: 'pipe',
      });

      this.checkpointId = stashMsg;
      logVerbose(chalk.green(`✓ Created checkpoint: ${name}`));
    } catch (error) {
      logVerbose(chalk.yellow('⚠️ Could not create checkpoint:'), error);
      // Don't fail the entire operation if checkpoint fails
    }
  }

  /**
   * Rollback to the last checkpoint
   */
  async rollback(): Promise<boolean> {
    if (!this.isGitRepo) {
      logVerbose(chalk.yellow('⚠️ Not a git repository, cannot rollback'));
      return false;
    }

    if (!this.checkpointId) {
      logVerbose(chalk.yellow('⚠️ No checkpoint to rollback to'));
      return false;
    }

    try {
      // Find the stash by message
      const stashList = execSync('git stash list', {
        cwd: this.cwd,
        encoding: 'utf-8',
        stdio: 'pipe',
      });

      const stashIndex = stashList
        .split('\n')
        .findIndex(line => line.includes(this.checkpointId!));

      if (stashIndex === -1) {
        logVerbose(chalk.yellow('⚠️ Checkpoint not found in stash'));
        return false;
      }

      // Reset working directory to HEAD
      execSync('git reset --hard HEAD', {
        cwd: this.cwd,
        stdio: 'pipe',
      });

      // Pop the stash
      execSync(`git stash pop stash@{${stashIndex}}`, {
        cwd: this.cwd,
        stdio: 'inherit',
      });

      console.log(chalk.green('✓ Rolled back to checkpoint'));
      this.checkpointId = null;
      return true;
    } catch (error) {
      console.log(chalk.red('❌ Rollback failed:'), error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  /**
   * Commit the checkpoint (drop stash because changes were successful)
   */
  async commit(): Promise<void> {
    if (!this.isGitRepo || !this.checkpointId) {
      return;
    }

    try {
      // Find and drop the stash
      const stashList = execSync('git stash list', {
        cwd: this.cwd,
        encoding: 'utf-8',
        stdio: 'pipe',
      });

      const stashIndex = stashList
        .split('\n')
        .findIndex(line => line.includes(this.checkpointId!));

      if (stashIndex !== -1) {
        execSync(`git stash drop stash@{${stashIndex}}`, {
          cwd: this.cwd,
          stdio: 'pipe',
        });
      }

      logVerbose(chalk.green('✓ Checkpoint committed'));
      this.checkpointId = null;
    } catch (error) {
      logVerbose(chalk.yellow('⚠️ Could not commit checkpoint:'), error);
      // Don't fail if we can't drop the stash - it will be cleaned up eventually
    }
  }

  /**
   * Check if a checkpoint is active
   */
  hasActiveCheckpoint(): boolean {
    return this.checkpointId !== null;
  }

  /**
   * Get the checkpoint ID
   */
  getCheckpointId(): string | null {
    return this.checkpointId;
  }
}
