import { useEffect, type ReactNode } from 'react';
import type { Reward } from './types';

const KIND_ICON: Record<Reward['kind'], string> = { sticker: '●', poster: '▭', community: '◆' };

export function Art({ reward, size = 28 }: { reward: Pick<Reward, 'art_url' | 'kind' | 'name'> | undefined; size?: number }) {
  if (!reward) return <span className="art empty" style={{ width: size, height: size }} />;
  return reward.art_url ? (
    <img className="art" src={reward.art_url} alt="" width={size} height={size} />
  ) : (
    <span className="art empty" style={{ width: size, height: size, fontSize: size * 0.45 }} title="No art yet">
      {KIND_ICON[reward.kind]}
    </span>
  );
}

export function RewardLabel({ reward }: { reward: Reward | undefined }) {
  if (!reward) return <span className="dim">(missing reward)</span>;
  const template = reward.subject_kind && !reward.artist_id && !reward.album_id;
  return (
    <span className="reward-label">
      <Art reward={reward} size={22} />
      <span>
        <span className={`kind k-${reward.kind}`}>{reward.kind}</span> {reward.name}
        {template && <span className="tag">per {reward.subject_kind}</span>}
      </span>
    </span>
  );
}

/** "Existing grants are kept": docs/REWARDS.md section 4, never-revoke. */
export function KeepNotice({ children }: { children: ReactNode }) {
  return (
    <div className="keep">
      <b>Existing grants are kept.</b> {children}
    </div>
  );
}

export function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  useEffect(() => {
    const on = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [onClose]);
  return (
    <div className="scrim" onMouseDown={onClose}>
      <div className="card modal" role="dialog" aria-label={title} onMouseDown={(e) => e.stopPropagation()}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}
