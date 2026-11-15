import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { bootstrap } from './bootstrap.ts';
import { Router, html, json, redirect, readBody } from './router.ts';
import type { Context } from './router.ts';
import { ROOT, PORT, today } from './config.ts';
import { sessionUser, signIn, signOut, safeNext, requireUser, localOnly } from './auth.ts';
import { AppError, integer, requireValue } from './errors.ts';
import { log, readLogs } from './log.ts';
import { search, parseSearch } from './domain/search.ts';
import { listingBySlug } from './db.ts';
import { quote, createBooking, guestBookings, guestBooking, cancelBooking, respondToReservation, flushOutbox } from './domain/bookings.ts';
import { placeHold, guestHolds, readHold, releaseHold } from './domain/holds.ts';
import { hostListings, ownedListing, saveListing } from './domain/listings.ts';
import { hostCalendar, listingCalendar, blockDates, unblockDates } from './domain/calendar.ts';
import { dashboard, reservations } from './domain/host.ts';
import { hostPayouts, payoutsCsv } from './domain/payouts.ts';
import { createTicket, tickets } from './domain/support.ts';
import { createFeedback } from './domain/feedback.ts';
import { flags, setFlag } from './flags.ts';
import { stats, health } from './domain/ops.ts';
import { startPages, type Pages } from './pages.ts';
import { openapi } from './openapi.ts';


function isLocal(req: http.IncomingMessage) {return ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress || '');}
/** The local page a form was posted from, for sending the person back with a message. */
function refererPath(req: http.IncomingMessage) {
 try {const ref=new URL(req.headers.referer || '/');return safeNext(ref.pathname+ref.search);} catch {return '/';}
}
function withError(path:string,message:string) {const next=new URL(path,'http://localhost');next.searchParams.delete('saved');next.searchParams.set('error',message);return next.pathname+next.search;}

/** The HTTP app: JSON API, form posts, images and logs. Pages, when attached, render every other GET. */
export function createApp(db: DatabaseSync = bootstrap(), pages?: Pages) {
 const router=new Router();
 const home=(slug:string)=>{const h=listingBySlug(db,slug);if(!h)throw new AppError(404,'NOT_FOUND','We could not find that home.');return h;};
 const host=(ctx:Context)=>requireUser(ctx.user,'host');
 const api=(method:string,path:string,fn:(c:Context)=>unknown)=>router.on(method,path,fn);
 const sendCsv=(ctx:Context)=>{const data=hostPayouts(db,host(ctx).id);ctx.res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="rentaplace-payouts.csv"'});ctx.res.end(payoutsCsv(data.items));};
 api('GET','/api/health',()=>health(db));
 api('GET','/api/openapi.json',()=>openapi);
 api('GET','/api/stats',ctx=>{localOnly(ctx.req);return stats(db);});
 api('GET','/api/home',()=>({featured:['lakeside-a-frame','pine-hollow-cabin','red-rock-casita','old-mill-loft'].map(home),regions:db.prepare('SELECT * FROM regions ORDER BY name').all()}));
 api('GET','/api/regions',()=>({items:db.prepare('SELECT * FROM regions ORDER BY name').all()}));
 api('GET','/api/session',ctx=>({user:ctx.user || null}));
 api('GET','/api/auth/accounts',()=>({items:db.prepare("SELECT id,name,role FROM users WHERE id IN ('guest-1','guest-2','host-1','host-5','host-6') ORDER BY role,id").all()}));
 api('POST','/api/auth/signin',ctx=>({user:signIn(db,String(ctx.body.userId),ctx.res)}));
 api('POST','/api/auth/signout',ctx=>{signOut(ctx.res);return {signedOut:true};});
 api('GET','/api/listings',ctx=>{const result=search(db,parseSearch(ctx.url.searchParams));ctx.res.setHeader('Server-Timing',`search;dur=${result.searchMs}`);return result;});
 api('GET','/api/listings/:slug',ctx=>{const h=home(ctx.params.slug);return {home:h,host:db.prepare('SELECT id,name FROM users WHERE id=?').get(h.host_id),reviews:db.prepare('SELECT rating,text,created_at FROM reviews WHERE listing_id=? ORDER BY created_at DESC LIMIT 20').all(h.id),calendar:listingCalendar(db,h,ctx.url.searchParams.get('month') || today().slice(0,7))};});
 api('GET','/api/quote',ctx=>quote(db,ctx.url.searchParams.get('slug') || '',ctx.url.searchParams.get('from') || '',ctx.url.searchParams.get('to') || '',integer(ctx.url.searchParams.get('guests') || 2,'Guests',1,20),ctx.user));
 api('GET','/api/holds',ctx=>({items:guestHolds(db,ctx.user)}));
 api('POST','/api/holds',ctx=>{const result=placeHold(db,ctx.body,ctx.user);json(ctx.res,result,result.replayed?200:201);});
 api('GET','/api/holds/:id',ctx=>({hold:readHold(db,ctx.params.id,ctx.user)}));
 api('POST','/api/holds/:id/release',ctx=>({hold:releaseHold(db,ctx.params.id,ctx.user)}));
 api('GET','/api/bookings',ctx=>({items:guestBookings(db,ctx.user)}));
 api('POST','/api/bookings',ctx=>{const result=createBooking(db,ctx.body,ctx.user);json(ctx.res,result,result.replayed?200:201);});
 api('GET','/api/bookings/:id',ctx=>({booking:guestBooking(db,ctx.params.id,ctx.user)}));
 api('POST','/api/bookings/:id/cancel',ctx=>({booking:cancelBooking(db,ctx.params.id,ctx.user)}));
 api('GET','/api/host/dashboard',ctx=>dashboard(db,ctx.user));
 api('GET','/api/host/listings',ctx=>({items:hostListings(db,ctx.user)}));
 api('POST','/api/host/listings',ctx=>json(ctx.res,{home:saveListing(db,ctx.body,ctx.user)},201));
 api('GET','/api/host/listings/:slug',ctx=>({home:ownedListing(db,ctx.params.slug,ctx.user)}));
 api('PATCH','/api/host/listings/:slug',ctx=>({home:saveListing(db,ctx.body,ctx.user,ctx.params.slug)}));
 api('GET','/api/host/calendar',ctx=>hostCalendar(db,ctx.user,ctx.url.searchParams.get('month') || today().slice(0,7),ctx.url.searchParams.get('slug') || undefined));
 api('POST','/api/host/calendar/blocks',ctx=>json(ctx.res,{block:blockDates(db,ctx.user,ctx.body)},201));
 api('DELETE','/api/host/calendar/blocks/:id',ctx=>unblockDates(db,ctx.user,ctx.params.id));
 api('GET','/api/host/reservations',ctx=>({items:reservations(db,ctx.user)}));
 api('POST','/api/host/reservations/:id/respond',ctx=>({booking:respondToReservation(db,ctx.params.id,String(ctx.body.action),ctx.user)}));
 api('GET','/api/host/payouts',ctx=>hostPayouts(db,host(ctx).id));
 api('GET','/api/host/payouts.csv',sendCsv);
 api('GET','/api/support',ctx=>{localOnly(ctx.req);return {items:tickets(db)};});
 api('POST','/api/support',ctx=>json(ctx.res,{ticket:createTicket(db,ctx.body,ctx.user)},201));
 api('GET','/api/feedback',ctx=>{localOnly(ctx.req);return {items:db.prepare('SELECT * FROM feedback ORDER BY created_at DESC,rowid DESC LIMIT 100').all()};});
 api('POST','/api/feedback',ctx=>json(ctx.res,{feedback:createFeedback(db,ctx.body,ctx.user)},201));
 api('GET','/api/flags',ctx=>{localOnly(ctx.req);return {items:flags(db)};});
 api('PATCH','/api/flags/:name',ctx=>{localOnly(ctx.req);const result=setFlag(db,ctx.params.name,ctx.body.enabled);log('flag.updated',result);return result;});
 api('GET','/api/logs',ctx=>{localOnly(ctx.req);return {items:readLogs({slow:ctx.url.searchParams.get('slow')==='1',errors:ctx.url.searchParams.get('errors')==='1',limit:integer(ctx.url.searchParams.get('limit')||100,'Limit',1,1000)})};});
 router.on('POST','/book/:slug',ctx=>{requireValue(ctx.body.agree==='1','Please review the house rules and cancellation policy.');const result=createBooking(db,{...ctx.body,slug:ctx.params.slug},ctx.user);redirect(ctx.res,`/bookings/${result.booking.id}`);});
 router.on('POST','/trips/:id/cancel',ctx=>{cancelBooking(db,ctx.params.id,ctx.user);redirect(ctx.res,'/trips?saved=1');});
 router.on('POST','/help',ctx=>{const t=createTicket(db,ctx.body,ctx.user);redirect(ctx.res,`/help?received=${t.id}`);});
 router.on('POST','/feedback',ctx=>{const f=createFeedback(db,ctx.body,ctx.user);const next=new URL(safeNext(ctx.body.next || f.page),'http://localhost');next.searchParams.set('feedback','1');redirect(ctx.res,next.pathname+next.search);});
 router.on('POST','/auth/signin',ctx=>{const u=signIn(db,String(ctx.body.userId),ctx.res);const next=safeNext(ctx.body.next);redirect(ctx.res,next==='/'&&u.role==='host'?'/host':next);});
 router.on('POST','/auth/signout',ctx=>{signOut(ctx.res);redirect(ctx.res,'/');});
 router.on('POST','/host/listings/new',ctx=>{const h=saveListing(db,ctx.body,ctx.user);redirect(ctx.res,`/host/listings/${h.slug}/edit?saved=1`);});
 router.on('POST','/host/listings/:slug/edit',ctx=>{saveListing(db,ctx.body,ctx.user,ctx.params.slug);redirect(ctx.res,`/host/listings/${ctx.params.slug}/edit?saved=1`);});
 router.on('POST','/host/calendar/block',ctx=>{const block=blockDates(db,ctx.user,ctx.body);redirect(ctx.res,`/host/calendar?slug=${encodeURIComponent(block.slug)}&month=${block.from.slice(0,7)}&saved=1`);});
 router.on('POST','/host/calendar/unblock/:id',ctx=>{unblockDates(db,ctx.user,ctx.params.id);redirect(ctx.res,'/host/calendar?saved=1');});
 router.on('POST','/host/reservations/:id/respond',ctx=>{respondToReservation(db,ctx.params.id,String(ctx.body.action),ctx.user);redirect(ctx.res,'/host/reservations?saved=1');});
 router.on('GET','/host/payouts.csv',sendCsv);
 router.on('POST','/admin/flags/:name',ctx=>{localOnly(ctx.req);const result=setFlag(db,ctx.params.name,ctx.body.enabled==='1');log('flag.updated',result);redirect(ctx.res,'/admin?saved=1');});
 const ASSET_TYPES:Record<string,string>={svg:'image/svg+xml',png:'image/png',jpg:'image/jpeg',webp:'image/webp',ico:'image/x-icon'};
 // Loopback, any *.localhost name (local dev proxies) and hosts listed in RAP_ALLOWED_HOSTS.
 const EXTRA_HOSTS=(process.env.RAP_ALLOWED_HOSTS || '').split(',').map(h=>h.trim().toLowerCase()).filter(Boolean);
 function allowedHost(header:string):boolean {
   const host=header.toLowerCase().replace(/:\d+$/,'');
   return /^(127\.0\.0\.1|localhost|\[::1\])$/.test(host) || /^([a-z0-9-]+\.)+localhost$/.test(host) || EXTRA_HOSTS.includes(host);
 }
 const server=http.createServer(async(req,res)=>{
   const start=performance.now(),requestId=randomUUID(),method=req.method || 'GET';
   const url=new URL(req.url || '/',`http://127.0.0.1:${PORT}`);
   res.setHeader('X-Request-Id',requestId);res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','same-origin');
   const quiet=url.pathname.startsWith('/_next/') || url.pathname.startsWith('/__nextjs');
   if(!quiet)res.on('finish',()=>log('http.request',{method,path:url.pathname,status:res.statusCode,ms:Number((performance.now()-start).toFixed(2)),requestId}));
   let user;
   try {
     const hostHeader=req.headers.host || '';
     if(!allowedHost(hostHeader))throw new AppError(403,'HOST_NOT_ALLOWED','Use the local server address.');
     if(['POST','PUT','PATCH','DELETE'].includes(method) && req.headers.origin) {
       let originHost='';try{originHost=new URL(req.headers.origin).host;}catch{}
       if(originHost!==hostHeader)throw new AppError(403,'ORIGIN_NOT_ALLOWED','This request must come from this local site.');
     }
     user=sessionUser(req,db);
     const routeMethod=method==='HEAD'?'GET':method;
     const asset=routeMethod==='GET' && /^\/img\/([a-z0-9-]+\/)*[a-z0-9.-]+\.(svg|png|jpg|webp|ico)$/.exec(url.pathname);
     if(asset && !url.pathname.includes('..')) {
       const path=join(ROOT,'public',url.pathname);
       if(!existsSync(path))throw new AppError(404,'NOT_FOUND','Asset not found.');
       res.writeHead(200,{'Content-Type':ASSET_TYPES[asset[2]],'Cache-Control':'public, max-age=86400'});res.end(method==='HEAD'?undefined:readFileSync(path));return;
     }
     if(router.matches(routeMethod,url.pathname) || url.pathname.startsWith('/api/') || !pages) {
       res.setHeader('Content-Security-Policy',"default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
       res.setHeader('Cache-Control','no-store');
       if(method==='HEAD')req.method='GET';
       await router.dispatch({req,res,db,url,params:{},user,body:await readBody(req),requestId});
       return;
     }
     // Pages only see a trustworthy "local" marker: set here from the socket, never taken from the client.
     delete req.headers['x-rap-local'];
     if(isLocal(req))req.headers['x-rap-local']='1';
     await pages.handle(req,res);
   } catch(error) {
     const err=error instanceof AppError?error:new AppError(error instanceof URIError?400:500,error instanceof URIError?'BAD_PATH':'INTERNAL_ERROR',error instanceof URIError?'Invalid URL encoding.':'Something went wrong. Please try again.');
     if(err.status>=500)log('request.failed',{requestId,message:error instanceof Error?error.message:'Unknown error'});
     if(!res.headersSent) {
       if(url.pathname.startsWith('/api/'))json(res,{error:{code:err.code,message:err.message,requestId}},err.status);
       else if(err.status===401)redirect(res,`/signin?next=${encodeURIComponent(method==='GET'?url.pathname+url.search:refererPath(req))}`);
       else if(method!=='GET' && method!=='HEAD')redirect(res,withError(refererPath(req),err.message));
       else json(res,{error:{code:err.code,message:err.message,requestId}},err.status);
     } else res.end();
   }
 });
 if(pages)server.on('upgrade',(req,socket,head)=>{if(allowedHost(req.headers.host || ''))pages.upgrade(req,socket,head);else socket.destroy();});
 return {server,db,router};
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 const db=bootstrap();
 const pages=await startPages(db,PORT);
 const {server}=createApp(db,pages);flushOutbox(db);
 server.listen(PORT,'127.0.0.1',()=>log('server.started',{host:'127.0.0.1',port:PORT,url:`http://127.0.0.1:${PORT}`,today:today(),pages:pages?pages.mode:'off'}));
 server.on('error',error=>{log('server.failed',{message:error.message});process.exitCode=1;db.close();});
 for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{server.close(()=>{db.close();process.exit(0);});setTimeout(()=>process.exit(0),2000).unref();});
}
