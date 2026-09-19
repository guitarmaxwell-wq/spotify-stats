-- Point reward art at PNG instead of SVG.
--
-- React Native's <Image> cannot render SVG without react-native-svg, so on a
-- phone -- the actual target -- every sticker fell back to the app's own
-- placeholder. The generator (tools/stickers/generate.py) now writes a PNG
-- beside each SVG and tools/stickers/upload.sh uploads both, so the same object
-- path exists in both formats.
--
-- The PNGs are 2x each design's canvas (stickers 1024x1024, posters 1200x1800),
-- with a transparent background: a sticker shown at ~160pt needs 480px on a 3x
-- phone, and 1024 leaves headroom for a full-screen look at one.
--
-- The SVGs stay in the bucket as the source for web and print; only art_url
-- moves. Swapping a row back is a one-line update.

update public.rewards
   set art_url = regexp_replace(art_url, '\.svg$', '.png')
 where art_url like 'https://%/storage/v1/object/public/reward-art/%.svg';

do $$
declare
  n int;
begin
  select count(*) into n
    from public.rewards
   where id::text like '5eed0000-%'
     and art_url like 'https://%/storage/v1/object/public/reward-art/%.png';
  if n <> 12 then
    raise exception 'reward_art_png: expected 12 seeded rewards on PNG art, found %', n;
  end if;
end;
$$;
