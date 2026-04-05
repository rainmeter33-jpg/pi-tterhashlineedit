import { computeLineHash, resolveEditAnchors, applyHashlineEdits } from "../src/hashline";
import { executeEditPipeline, type DualAnchorToolEdit } from "../src/pipeline";

const REAL_FILE_CONTENT = `import { Request, Response } from "express";
import { verify } from "jsonwebtoken";
import { UserService } from "../services/user";
import { Logger } from "../utils/logger";

const logger = new Logger("auth-controller");
const userService = new UserService();

export async function login(req: Request, res: Response): Promise<void> {
  const { email, password } = req.body;

  if (!email || !password) {
    res.status(400).json({ error: "Email and password required" });
    return;
  }

  try {
    const user = await userService.findByEmail(email);
    if (!user || !user.validatePassword(password)) {
      logger.warn("Failed login attempt", { email });
      res.status(401).json({ error: "Invalid credentials" });
      return;
    }

    const token = verify.sign({ id: user.id }, process.env.JWT_SECRET!, {
      expiresIn: "24h",
    });

    logger.info("User logged in", { userId: user.id });
    res.json({ token, user: { id: user.id, email: user.email } });
  } catch (error) {
    logger.error("Login error", error);
    res.status(500).json({ error: "Internal server error" });
  }
}`;

function ref(lineNum: number, content: string): string {
	const lines = content.split("\n");
	return `${lineNum}#${computeLineHash(lineNum, lines[lineNum - 1]!)}`;
}

// DEBUG Scenario 1: anchor2 on line 21 after content change
console.log("=== SCÉNARIO 1 DEBUG ===");
const originalLines = REAL_FILE_CONTENT.split("\n");
const currentContent = REAL_FILE_CONTENT.replace(
	'res.status(401).json({ error: "Invalid credentials" })',
	'res.status(401).json({ error: "Invalid credentials", code: "AUTH_FAILED" })',
);
const currentLines = currentContent.split("\n");

// Show line 21 in both versions
console.log(`Original line 21: "${originalLines[20]}"`);
console.log(`Current  line 21: "${currentLines[20]}"`);
console.log(`Original hash 21: ${computeLineHash(21, originalLines[20]!)}`);
console.log(`Current  hash 21: ${computeLineHash(21, currentLines[20]!)}`);
console.log(`ref(21, original): ${ref(21, REAL_FILE_CONTENT)}`);
console.log(`ref(21, current):  ${ref(21, currentContent)}`);

// The anchor2 uses ref(21, REAL_FILE_CONTENT) but content is currentContent
// So the hash was computed from the ORIGINAL content, not the current content
// The pipeline uses currentContent as input, so ref should be from currentContent... 
// BUT in the test we call ref(21, REAL_FILE_CONTENT) for anchor2 while passing currentContent

// That's the bug in the test! anchor2 should reference the content AS SEEN by the model
// The model saw REAL_FILE_CONTENT and got ref(21, REAL_FILE_CONTENT)
// But the file on disk is now currentContent with a DIFFERENT hash on line 21
// So the anchor should be STALE and the pipeline should fail at validate

// Let's check what happens
const anchor2Ref = ref(21, REAL_FILE_CONTENT);
console.log(`\nanchor2 = ${anchor2Ref}`);
console.log(`Actual hash on line 21 in currentContent: ${computeLineHash(21, currentLines[20]!)}`);

// The issue: computeLineHash gets the SAME content for line 21 because
// .replace() changes it but the line number content differs
// Let me check if they're actually different
console.log(`\nAre they equal? ${originalLines[20] === currentLines[20]}`);

// DEBUG Scenario 2: anchor2 in edit zone
console.log("\n=== SCÉNARIO 2 DEBUG ===");
// Edit zone: 19-22
// anchor2 = ref(20, REAL_FILE_CONTENT) — line 20 is IN zone 19-22
const anchor20 = ref(20, REAL_FILE_CONTENT);
console.log(`Line 19: "${originalLines[18]}"`);
console.log(`Line 20: "${originalLines[19]}"`);
console.log(`Line 21: "${originalLines[20]}"`);
console.log(`Line 22: "${originalLines[21]}"`);
console.log(`anchor2 (line 20) = ${anchor20}`);
console.log(`Edit zone: 19-22 inclusive`);
console.log(`Is line 20 in zone 19-22? YES (20 >= 19 && 20 <= 22)`);
