# Contributing to MeerAI CLI

Thank you for your interest in contributing to MeerAI CLI! This document provides guidelines and information for contributors.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [Project Structure](#project-structure)
- [Contributing Guidelines](#contributing-guidelines)
- [Development Workflow](#development-workflow)
- [Testing](#testing)
- [Code Style](#code-style)
- [Pull Request Process](#pull-request-process)
- [Issue Reporting](#issue-reporting)

## Code of Conduct

This project follows a code of conduct that we expect all contributors to adhere to:

- Be respectful and inclusive
- Use welcoming and inclusive language
- Accept constructive criticism gracefully
- Focus on what's best for the community
- Show empathy towards other community members

## Getting Started

### Prerequisites

- Node.js (v20 or higher)
- npm or yarn
- Git

### Fork and Clone

1. Fork the repository on GitHub
2. Clone your fork locally:
   ```bash
   git clone https://github.com/meer-ai/meer.git
   cd meer
   ```
3. Add the upstream remote:
   ```bash
   git remote add upstream https://github.com/meer-ai/meer.git
   ```

## Development Setup

### Installation

1. Install dependencies:

   ```bash
   npm install
   ```

2. Build the project:

   ```bash
   npm run build
   ```

3. Link the CLI globally for testing:
   ```bash
   npm link
   ```

### Environment Setup

1. Copy the example configuration:

   ```bash
   cp .env.example .env
   ```

2. Configure your API keys in `.env`:
   ```env
   OPENAI_API_KEY=your_openai_key
   ANTHROPIC_API_KEY=your_anthropic_key
   GEMINI_API_KEY=your_gemini_key
   ```

## Project Structure

```
src/
├── agent/           # AI agent workflow and logic
├── commands/        # CLI command implementations
├── providers/       # AI provider integrations
├── tools/          # Tool implementations for the agent
├── ui/             # User interface components
├── session/        # Session management
└── cli.ts          # Main CLI entry point
```

### Key Components

- **Agent Workflow** (`src/agent/workflow.ts`): Core AI agent logic
- **Tools** (`src/tools/index.ts`): Available tools for the agent
- **Providers** (`src/providers/`): AI service integrations
- **Commands** (`src/commands/`): CLI command implementations

## Contributing Guidelines

### Types of Contributions

We welcome contributions in the following areas:

- **Bug Fixes**: Fix existing issues
- **Feature Additions**: Add new functionality
- **Documentation**: Improve docs and comments
- **Testing**: Add or improve tests
- **Performance**: Optimize existing code
- **UI/UX**: Improve user experience

### Before You Start

1. Check existing issues and pull requests
2. Discuss major changes in an issue first
3. Ensure your changes align with the project goals
4. Follow the existing code style and patterns

## Development Workflow

### Branch Naming

Use descriptive branch names:

- `feature/add-image-analysis`
- `fix/path-parsing-issue`
- `docs/update-contributing`
- `refactor/improve-workflow`

### Commit Messages

Follow conventional commit format:

```
type(scope): description

[optional body]

[optional footer]
```

Examples:

- `feat(agent): add image analysis capability`
- `fix(cli): handle escaped spaces in file paths`
- `docs: update contributing guidelines`

### Development Process

1. Create a new branch from `main`:

   ```bash
   git checkout -b feature/your-feature-name
   ```

2. Make your changes

3. Test your changes:

   ```bash
   npm run build
   npm test
   ```

4. Commit your changes:

   ```bash
   git add .
   git commit -m "feat: add your feature"
   ```

5. Push to your fork:

   ```bash
   git push origin feature/your-feature-name
   ```

6. Create a pull request

## Testing

### Running Tests

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Run tests with coverage
npm run test:coverage
```

### Test Structure

- Unit tests: `tests/unit/`
- Integration tests: `tests/integration/`
- E2E tests: `tests/e2e/`

### Writing Tests

- Write tests for new features
- Ensure existing tests still pass
- Aim for good test coverage
- Use descriptive test names

## Code Style

### TypeScript Guidelines

- Use TypeScript strict mode
- Prefer interfaces over types for object shapes
- Use meaningful variable and function names
- Add JSDoc comments for public APIs

### Code Formatting

We use Prettier for code formatting:

```bash
# Format code
npm run format

# Check formatting
npm run format:check
```

### Linting

We use ESLint for code linting:

```bash
# Run linter
npm run lint

# Fix linting issues
npm run lint:fix
```

### File Organization

- One main export per file
- Group related functionality
- Use barrel exports for clean imports
- Keep files focused and small

## Pull Request Process

### Before Submitting

1. Ensure all tests pass
2. Run linting and formatting
3. Update documentation if needed
4. Add tests for new features
5. Update CHANGELOG.md if applicable

### PR Template

When creating a pull request, include:

- **Description**: What changes were made and why
- **Type**: Bug fix, feature, documentation, etc.
- **Testing**: How the changes were tested
- **Breaking Changes**: Any breaking changes
- **Related Issues**: Link to related issues

### Review Process

1. Automated checks must pass
2. Code review by maintainers
3. Address feedback and suggestions
4. Maintainers will merge when ready

## Issue Reporting

### Bug Reports

When reporting bugs, include:

- **Description**: Clear description of the issue
- **Steps to Reproduce**: Detailed steps to reproduce
- **Expected Behavior**: What should happen
- **Actual Behavior**: What actually happens
- **Environment**: OS, Node.js version, CLI version
- **Screenshots**: If applicable

### Feature Requests

For feature requests, include:

- **Use Case**: Why this feature would be useful
- **Proposed Solution**: How you think it should work
- **Alternatives**: Other solutions you've considered
- **Additional Context**: Any other relevant information

## Development Tips

### Debugging

- Use `console.log` for debugging (remove before committing)
- Use the debugger in your IDE
- Check logs in the CLI output
- Test with different AI providers

### Performance

- Profile code for performance bottlenecks
- Use efficient algorithms and data structures
- Minimize API calls to AI providers
- Cache results when appropriate

### Security

- Never commit API keys or secrets
- Use environment variables for configuration
- Validate user input
- Follow security best practices

## Getting Help

- **Documentation**: Check the README and code comments
- **Issues**: Search existing issues first
- **Discussions**: Use GitHub Discussions for questions
- **Community**: Join our community channels

## Recognition

Contributors will be recognized in:

- CONTRIBUTORS.md file
- Release notes
- Project documentation

## License

By contributing, you agree that your contributions will be licensed under the same license as the project.

---

Thank you for contributing to MeerAI CLI! 🚀
