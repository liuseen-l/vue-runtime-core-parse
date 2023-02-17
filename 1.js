let a = Promise.resolve(2)

a.then((z)=>{
  console.log(3);
})

a.then((z)=>{
  console.log(4);
})