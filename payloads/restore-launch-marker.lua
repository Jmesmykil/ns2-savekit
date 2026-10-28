-- Saved launcher marker.
-- No native probes.
local e = ...
local base = 'save:'
pcall(function()
  local s = e:var('s.savepath')
  if type(s)=='string' then
    base=s
  end
end)
local n=0
local name=
  '/ns2jb-boot-count.txt'
local f=io.open(base..name,'rb')
if f then
  n=tonumber(f:read(16)) or 0
  f:close()
end
n=(n%999999)+1
f=io.open(base..name,'wb')
if f then
  f:write(tostring(n),'\n')
  f:flush()
  f:close()
end
pcall(function()
  e:tag{'jump',
    file='system/first.iet',
    label='title'}
end)
pcall(function()
  e:tag{'dialog',
    title='Saved launcher',
    message='Launch '..n}
end)
