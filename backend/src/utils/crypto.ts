import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const SALT_LENGTH = 64;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;

// Get encryption key from environment or generate a default one (INSECURE - should be in .env)
function getEncryptionKey(): string {
  const key = process.env.ENCRYPTION_KEY;
  if (!key) {
    console.warn('⚠️  WARNING: ENCRYPTION_KEY not set in .env - using default key (INSECURE)');
    return 'default-insecure-key-please-change-this-in-production-env-file';
  }
  return key;
}

// Derive a cryptographic key from the password
function deriveKey(password: string, salt: Buffer): Buffer {
  return crypto.pbkdf2Sync(password, salt, 100000, KEY_LENGTH, 'sha512');
}

/**
 * Encrypt a password using AES-256-GCM
 * Returns: salt:iv:encrypted:authTag (all hex encoded)
 */
export function encryptPassword(password: string): string {
  try {
    const masterKey = getEncryptionKey();
    
    // Generate random salt and IV
    const salt = crypto.randomBytes(SALT_LENGTH);
    const iv = crypto.randomBytes(IV_LENGTH);
    
    // Derive encryption key from master key
    const key = deriveKey(masterKey, salt);
    
    // Create cipher
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    
    // Encrypt
    let encrypted = cipher.update(password, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    
    // Get auth tag
    const authTag = cipher.getAuthTag();
    
    // Return as salt:iv:encrypted:authTag
    return `${salt.toString('hex')}:${iv.toString('hex')}:${encrypted}:${authTag.toString('hex')}`;
  } catch (error) {
    console.error('Encryption failed:', error);
    throw new Error('Failed to encrypt password');
  }
}

/**
 * Decrypt a password encrypted with encryptPassword
 * Input format: salt:iv:encrypted:authTag (all hex encoded)
 */
export function decryptPassword(encryptedData: string): string {
  try {
    const masterKey = getEncryptionKey();
    
    // Parse the encrypted data
    const parts = encryptedData.split(':');
    if (parts.length !== 4) {
      throw new Error('Invalid encrypted data format');
    }
    
    const salt = Buffer.from(parts[0], 'hex');
    const iv = Buffer.from(parts[1], 'hex');
    const encrypted = parts[2];
    const authTag = Buffer.from(parts[3], 'hex');
    
    // Derive the same key
    const key = deriveKey(masterKey, salt);
    
    // Create decipher
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    
    // Decrypt
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
  } catch (error) {
    console.error('Decryption failed:', error);
    throw new Error('Failed to decrypt password');
  }
}

/**
 * Check if a string appears to be encrypted
 */
export function isEncrypted(value: string): boolean {
  // Check if it matches our format: hex:hex:hex:hex
  const parts = value.split(':');
  if (parts.length !== 4) return false;
  
  // Check if all parts are hex strings
  const hexPattern = /^[0-9a-f]+$/i;
  return parts.every(part => hexPattern.test(part));
}
