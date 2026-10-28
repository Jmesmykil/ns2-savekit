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
local editor_ok,editor_error=pcall(function()
  assert(type(sys)=='table' and type(pluto)=='table','game save metadata unavailable')
  sys.saveslot=sys.saveslot or {}
  local title='LUA EDITOR / SLOT 3'
  sys.saveslot[3]={file='save0003',title={text=title,en=title,ja=title,cn=title},
    text={text=title,en=title,ja=title,cn=title},com=title,date=os.time()}
  sys.saveslot.lock=sys.saveslot.lock or {}
  sys.saveslot.check=sys.saveslot.check or {}
  sys.saveslot.lock[3]=true
  sys.saveslot.check.save0003=true
  sys.saveslot.count=math.max(tonumber(sys.saveslot.count) or 0,3)
  e:tag{'var',name='g.system',data=pluto.persist({},sys)}
  e:tag{'save',file='ssedit-commit.dat'}
end)
pcall(function()
  local status=io.open(base..'/ns2jb-editor-status.txt','wb')
  if status then
    status:write(editor_ok and 'slot3 registered\n' or ('slot3 failed: '..tostring(editor_error)..'\n'))
    status:flush()
    status:close()
  end
end)
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
