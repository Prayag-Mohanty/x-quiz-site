/**
 * Where uploaded files live.
 *
 * Its own module because both the media routes and the sealing routes need it,
 * and importing it from either of those would make them import each other.
 * Phase 2 swaps the directory for object storage; this is the one place that
 * knows where bytes are today.
 */

import { join } from 'node:path';

export const UPLOAD_DIR = join(process.cwd(), 'uploads');
