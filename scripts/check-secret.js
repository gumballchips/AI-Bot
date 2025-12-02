// Simple script used by GitHub Actions to verify OPENAI_API_KEY is available in the env.
// Do NOT print the key value.

if (process.env.OPENAI_API_KEY) {
  console.log("OPENAI_API_KEY is set (value redacted).");
  process.exit(0);
} else {
  console.error("ERROR: OPENAI_API_KEY is not set in the environment.");
  console.error("Please add it in repository Settings → Secrets and variables → Actions → New repository secret (name: OPENAI_API_KEY).");
  process.exit(1);
}
