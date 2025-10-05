# 📦 Publishing Guide

This document explains how to set up automated publishing to npmjs using GitHub Actions.

## 🔧 Setup Instructions

### 1. NPM Token Configuration

1. **Create an NPM account** at [npmjs.com](https://www.npmjs.com) if you don't have one
2. **Generate an automation token**:
   - Go to [npm Access Tokens](https://www.npmjs.com/settings/tokens)
   - Click "Generate New Token" 
   - Select "Automation" (recommended for CI/CD)
   - Copy the token (starts with `npm_...`)

3. **Add the token to GitHub Secrets**:
   - Go to your GitHub repository
   - Navigate to Settings → Secrets and variables → Actions
   - Click "New repository secret"
   - Name: `NPM_TOKEN`
   - Value: Your npm token
   - Click "Add secret"

### 2. Repository Permissions

Ensure your GitHub repository has the following permissions:
- **Contents**: Read (for checking out code)
- **ID Token**: Write (for npm provenance)

These are automatically configured in the workflow file.

## 🚀 Publishing Process

### Automated Publishing (Recommended)

1. **Use the release script**:
   ```bash
   ./scripts/release.sh
   ```
   
   This script will:
   - Prompt you for the version type (patch/minor/major/custom)
   - Update package.json version
   - Build and test the project
   - Create a git tag
   - Push to GitHub
   - Trigger the automated publishing

2. **Manual tagging** (alternative):
   ```bash
   # Update version in package.json
   npm version patch  # or minor, major
   
   # Push changes and tags
   git push origin main
   git push origin --tags
   ```

### Manual Publishing (Local)

If you need to publish manually:

```bash
# Build the project
npm run build

# Login to npm (one-time setup)
npm login

# Publish
npm publish --access public
```

## 📋 Workflow Details

The GitHub Action (`.github/workflows/publish.yml`) triggers when:
- A tag starting with `v` is pushed (e.g., `v1.0.0`, `v0.4.1`)

The workflow performs these steps:
1. **Checkout** the code
2. **Setup Node.js** (version 20)
3. **Install** dependencies with `npm ci`
4. **Build** the project with `npm run build`
5. **Run tests** with `npm test`
6. **Extract version** from the git tag
7. **Update package.json** with the tag version
8. **Publish to npm** with provenance
9. **Create GitHub Release** with release notes

## 🔍 Monitoring

- **GitHub Actions**: Monitor the publishing process at `https://github.com/YOUR_ORG/meer/actions`
- **NPM Package**: Check the published package at `https://www.npmjs.com/package/meerai`
- **Releases**: View releases at `https://github.com/YOUR_ORG/meer/releases`

## 🛠 Troubleshooting

### Common Issues

1. **`NPM_TOKEN` not set**:
   - Error: `npm ERR! code ENEEDAUTH`
   - Solution: Add the `NPM_TOKEN` secret in GitHub repository settings

2. **Package name conflict**:
   - Error: `npm ERR! 403 Forbidden`
   - Solution: Choose a unique package name in `package.json`

3. **Version already exists**:
   - Error: `npm ERR! 403 You cannot publish over the previously published versions`
   - Solution: Bump the version number before publishing

4. **Build failure**:
   - Error: TypeScript compilation errors
   - Solution: Fix the build errors locally and push the fixes

5. **Test failures**:
   - Error: Tests fail during CI
   - Solution: Ensure all tests pass locally before tagging

### Debug Commands

```bash
# Check current version
npm version

# Check if package builds successfully
npm run build

# Check if tests pass
npm test

# Dry run publish (doesn't actually publish)
npm publish --dry-run

# Check what files will be included
npm pack --dry-run
```

## 📝 Version Strategy

We use [Semantic Versioning](https://semver.org/):
- **Patch** (0.3.0 → 0.3.1): Bug fixes, small improvements
- **Minor** (0.3.0 → 0.4.0): New features, backward compatible
- **Major** (0.3.0 → 1.0.0): Breaking changes

## 🔐 Security

- **Provenance**: The workflow uses npm provenance for supply chain security
- **Access Control**: Uses automation tokens with minimal required permissions
- **Token Security**: NPM tokens are stored as GitHub secrets (encrypted)

## 📚 Additional Resources

- [NPM Publishing Documentation](https://docs.npmjs.com/packages-and-modules/contributing-packages-to-the-registry)
- [GitHub Actions for NPM](https://docs.github.com/en/actions/publishing-packages/publishing-nodejs-packages)
- [NPM Provenance](https://docs.npmjs.com/generating-provenance-statements)