import 'dotenv/config';import {PrismaClient} from '@prisma/client';
const [,, from, to] = process.argv;
const p=new PrismaClient();
const rows=await p.outagePost.findMany({where:{postedAt:{gte:new Date(from),lt:new Date(to)}},include:{post:{include:{extractions:true}}},orderBy:{postedAt:'asc'}});
const short=new Map();
for(const r of rows){const e=r.post.extractions[0]?.result;if(!e)continue;
 if(!short.has(r.outageId))short.set(r.outageId,'O'+short.size);
 const t=(r.post.noteTweetText||r.post.text).replace(/#\w+/g,'').replace(/https?:\/\/\S+/g,'').replace(/\s+/g,' ').trim().slice(0,150);
 console.log(r.post.externalId.slice(-6),r.postedAt.toISOString().slice(5,16),(e.sdc??'').slice(0,5),e.relevance.slice(0,2),e.status.slice(0,4),'|',e.entities.filter(x=>x.type!=='SDC').map(x=>x.name).join('/').slice(0,38),'|',e.localities.slice(0,3).map(l=>l.name).join('/').slice(0,38),'|',t,'=>',short.get(r.outageId));}
console.log(rows.length);await p.$disconnect();
