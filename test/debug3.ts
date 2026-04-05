// Debug test 2 - verify anchor2 hash mismatch
import { computeLineHash, parseLineRef } from "../src/hashline";

const FILE = `import { Router } from "express";
import { authenticate } from "../middleware/auth";
import { validateBody } from "../middleware/validate";
import { UserService } from "../services/user";
import { Database } from "../utils/database";
import { Logger } from "../utils/logger";
import { hashPassword, comparePassword } from "../utils/crypto";

const router = Router();
const logger = new Logger("user-routes");
const db = new Database();
const userService = new UserService(db);

// POST /api/users/register
router.post("/register", validateBody(["email", "password", "name"]), async (req, res) => {
  const { email, password, name } = req.body;

  try {
    const existing = await userService.findByEmail(email);
    if (existing) {
      return res.status(409).json({ error: "Email already exists" });
    }

    const hashed = await hashPassword(password);
    const user = await userService.create({ email, password: hashed, name });

    logger.info("User registered", { userId: user.id });
    return res.status(201).json({ id: user.id, email: user.email, name });
  } catch (err) {
    logger.error("Registration failed", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/users/login
router.post("/login", validateBody(["email", "password"]), async (req, res) => {
  const { email, password } = req.body;

  try {
    const user = await userService.findByEmail(email);
    if (!user) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const valid = await comparePassword(password, user.password);
    if (!valid) {
      logger.warn("Failed login", { email });
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const token = authenticate.generateToken(user.id);
    logger.info("User logged in", { userId: user.id });
    return res.json({ token, user: { id: user.id, email: user.email, name: user.name } });
  } catch (err) {
    logger.error("Login failed", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/users/:id
router.get("/:id", authenticate, async (req, res) => {
  try {
    const user = await userService.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }
    return res.json({ id: user.id, email: user.email, name: user.name });
  } catch (err) {
    logger.error("Get user failed", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
`;

const staleFile = FILE.replace(
  'return res.status(409).json({ error: "Email already exists" })',
  'return res.status(409).json({ error: "Email already exists", code: "CONFLICT" })',
);

const fileLines = FILE.split("\n");
const staleLines = staleFile.split("\n");

// anchor2 ref from ORIGINAL file
const anchor2Ref = "21#" + computeLineHash(21, fileLines[20]!);
console.log("anchor2 ref (from original):", anchor2Ref);

// Actual hash in stale file
const actualHash = computeLineHash(21, staleLines[20]!);
console.log("Actual hash in stale file:", "21#" + actualHash);

// Do they match?
const parsed = parseLineRef(anchor2Ref);
console.log("\nParsed anchor2:", parsed);
console.log("Expected hash:", parsed.hash);
console.log("Actual hash:  ", actualHash);
console.log("Match:", parsed.hash === actualHash);