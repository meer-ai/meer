import { readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

export function getVersion(): string {
    try {
        // Get the directory path of the current module
        const __filename = fileURLToPath(import.meta.url);
        const __dirname = dirname(__filename);
        
        // Read package.json from project root (two levels up from commands directory)
        const packageJson = JSON.parse(
            readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')
        );
        return packageJson.version;
    } catch (error) {
        console.error('Error reading version:', error);
        return 'unknown';
    }
}

export async function handleVersion(): Promise<void> {
    const version = getVersion();
    console.log(version);
}