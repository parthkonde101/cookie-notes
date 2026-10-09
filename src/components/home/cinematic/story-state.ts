import { createContext, useContext } from 'react';

/**
 * The one number the whole experience is driven by.
 *
 * `target` is where the scrollbar is; `smooth` chases it, and is what the
 * camera, the scene and the text all read. It is a plain mutable object —
 * not React state — so it can change sixty times a second without rendering
 * anything.
 */
export interface StoryState {
  target: number;
  smooth: number;
  /** How fast `smooth` is moving, per second. Kept so the follow is continuous in speed. */
  velocity: number;
  subscribers: Set<(progress: number) => void>;
}

export function createStoryState(): StoryState {
  return { target: 0, smooth: 0, velocity: 0, subscribers: new Set() };
}

export const StoryContext = createContext<StoryState | null>(null);

export function useStory(): StoryState {
  const story = useContext(StoryContext);
  if (!story) throw new Error('useStory must be used inside the story scene');
  return story;
}
