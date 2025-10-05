#!/bin/bash

# MeerAI Release Script
# This script helps create tagged releases that trigger the GitHub Action to publish to npm

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to print colored output
print_status() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check if we're in a git repository
if ! git rev-parse --git-dir > /dev/null 2>&1; then
    print_error "Not in a git repository"
    exit 1
fi

# Check if working directory is clean
if ! git diff-index --quiet HEAD --; then
    print_error "Working directory is not clean. Please commit or stash your changes."
    exit 1
fi

# Get current version from package.json
CURRENT_VERSION=$(node -p "require('./package.json').version")
print_status "Current version: $CURRENT_VERSION"

# Ask for new version
echo ""
echo "Release types:"
echo "  1) patch (0.3.0 -> 0.3.1)"
echo "  2) minor (0.3.0 -> 0.4.0)"
echo "  3) major (0.3.0 -> 1.0.0)"
echo "  4) custom (specify exact version)"
echo ""
read -p "Select release type (1-4): " release_type

case $release_type in
    1)
        NEW_VERSION=$(npm version patch --no-git-tag-version)
        ;;
    2)
        NEW_VERSION=$(npm version minor --no-git-tag-version)
        ;;
    3)
        NEW_VERSION=$(npm version major --no-git-tag-version)
        ;;
    4)
        read -p "Enter the new version (e.g., 1.0.0): " custom_version
        if [[ ! $custom_version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
            print_error "Invalid version format. Use semantic versioning (e.g., 1.0.0)"
            exit 1
        fi
        NEW_VERSION=$(npm version $custom_version --no-git-tag-version)
        ;;
    *)
        print_error "Invalid selection"
        exit 1
        ;;
esac

# Remove 'v' prefix from NEW_VERSION if present
NEW_VERSION=${NEW_VERSION#v}

print_status "New version: $NEW_VERSION"

# Build the project to ensure it works
print_status "Building project..."
if ! npm run build; then
    print_error "Build failed. Aborting release."
    exit 1
fi

print_success "Build successful"

# Run tests
print_status "Running tests..."
if ! npm test; then
    print_error "Tests failed. Aborting release."
    exit 1
fi

print_success "Tests passed"

# Create release notes
RELEASE_NOTES="Release v$NEW_VERSION

## Changes
$(git log --oneline $(git describe --tags --abbrev=0)..HEAD | sed 's/^/- /')"

# Commit the version change
print_status "Committing version change..."
git add package.json package-lock.json
git commit -m "🚀 Release v$NEW_VERSION"

# Create and push tag
print_status "Creating tag v$NEW_VERSION..."
git tag -a "v$NEW_VERSION" -m "$RELEASE_NOTES"

print_status "Pushing changes and tag to origin..."
git push origin main
git push origin "v$NEW_VERSION"

print_success "Release v$NEW_VERSION created successfully!"
print_status "GitHub Action will automatically publish to npm when the tag is pushed."
print_status "Monitor the action at: https://github.com/$(git config --get remote.origin.url | sed 's/.*github.com[:/]\(.*\)\.git/\1/')/actions"

echo ""
print_status "Release notes:"
echo "$RELEASE_NOTES"