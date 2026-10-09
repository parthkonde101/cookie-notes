/**
 * Where the character's model lives, and a way to start fetching it early.
 *
 * Deliberately free of Three.js: the page can begin the download the moment it
 * knows the scene will run, in parallel with the 3D code itself, instead of
 * waiting for that code to arrive and only then asking for the model. The scene
 * reads the same promise, so the file is fetched once.
 */
export const STUDENT_MODEL = '/home/student.glb';

let pending: Promise<ArrayBuffer> | null = null;

export function prefetchStudent(): Promise<ArrayBuffer> {
  if (!pending) {
    pending = fetch(STUDENT_MODEL)
      .then((response) => {
        if (!response.ok) throw new Error(`student model: ${response.status}`);
        return response.arrayBuffer();
      })
      .catch((error) => {
        // Let a later attempt try again rather than caching the failure.
        pending = null;
        throw error;
      });
  }
  return pending;
}
