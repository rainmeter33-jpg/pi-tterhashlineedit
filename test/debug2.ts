// Debug: why does scenario 1 pass validate?
import { computeLineHash, resolveEditAnchors, applyHashlineEdits, parseLineRef } from "../src/hashline";
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

const currentContent = REAL_FILE_CONTENT.replace(
	'res.status(401).json({ error: "Invalid credentials" })',
	'res.status(401).json({ error: "Invalid credentials", code: "AUTH_FAILED" })',
);

// Build the edit exactly like the test does
const anchor1 = ref(17, REAL_FILE_CONTENT);
const anchor2 = ref(21, REAL_FILE_CONTENT); // Uses ORIGINAL content for hash
const pos = ref(25, currentContent);

console.log("pos:", pos);
console.log("anchor1:", anchor1);
console.log("anchor2:", anchor2);

// Check: what hash does currentContent have on line 17 and 21?
const currentLines = currentContent.split("\n");
console.log("\nLine 17 in currentContent:", currentLines[16]);
console.log("Hash:", computeLineHash(17, currentLines[16]!));
console.log("anchor1 expects:", parseLineRef(anchor1).hash);

console.log("\nLine 21 in currentContent:", currentLines[20]);
console.log("Hash:", computeLineHash(21, currentLines[20]!));
console.log("anchor2 expects:", parseLineRef(anchor2).hash);

// Line 17 is unchanged so anchor1 should match
// Line 21 is changed so anchor2 should NOT match
// If validateContextAnchors uses currentContent, it should fail

// Run the pipeline
const edits: DualAnchorToolEdit[] = [{
	op: "replace",
	pos: ref(25, currentContent),
	lines: ['    const token = verify.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET!, {'],
	anchor1: anchor1,
	anchor2: anchor2,
}];

executeEditPipeline(currentContent, edits, { absolutePath: undefined }).then(result => {
	console.log("\n=== Pipeline result ===");
	console.log("Success:", result.success);
	for (const s of result.stages) {
		console.log(`  ${s.stage}: ${s.passed ? "✅" : "❌"} — ${s.message.substring(0, 80)}`);
	}
	console.log("Errors:", result.errors);
});
