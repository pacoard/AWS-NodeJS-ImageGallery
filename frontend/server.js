var express = require("express");
var app = express();
var bodyParser = require("body-parser");
var crypto = require("crypto");
var mime = require("mime");
var multer = require("multer"); //File upload (local)
var aws = require('aws-sdk'); //AWS interaction
var fs = require('fs');
var path = require('path');
app.set('view engine', 'ejs');

//////////////////////
// GLOBAL CONSTANTS //
//////////////////////
var PORT = 8000;
var API_URL = '/api';
var LOCAL_IMAGES_PATH = 'images/';
var s3 = new aws.S3();
var sqs = new aws.SQS({region:t_AVAILABILITY_ZONE}); 
//sed -i 's/"t_VALUE"/\"actual_value\"/g' server.js
var S3_BUCKET_NAME = t_S3_BUCKET_NAME;
var DB_HOST = t_DB_HOST;
var DB_USERNAME = t_DB_USERNAME;
var DB_PASSWORD = t_DB_PASSWORD;
var SQS_URL = t_SQS_URL;

var DB_PORT = '8000';
var DB_NAME = 'imagesdb'; 
///////////////////////
// DB Initialization //
///////////////////////
var mysql = require('mysql'); 
//Update dbConnection to automatically connect to the created DB
dbConnection = mysql.createConnection({
  host     : DB_HOST,
  user     : DB_USERNAME,
  password : DB_PASSWORD,
  port     : DB_PORT,
  database : DB_NAME
});
sql = 'CREATE TABLE images (\
        id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,\
        email VARCHAR(32),\
        phone VARCHAR(32),\
        url VARCHAR(255),\
        bwurl VARCHAR(255),\
        status INT(1),\
        receipt VARCHAR(255))';
dbConnection.query(sql, function (err, result) {
  console.log(sql);
  if (err) {
    //throw err;
    console.log('Error: ' + err);
    return;
  }
  console.log("Result: " + result);
});

////////////////////////////////////////////////////
// Middlewares and functions to be called in POST //
////////////////////////////////////////////////////
var fileName = '';
// MW: save uploaded image locally
var upload = multer({
  dest: LOCAL_IMAGES_PATH, 
  storage: multer.diskStorage({
    destination: function (req, file, cb) {
      cb(null, LOCAL_IMAGES_PATH)
    },
    filename: function (req, file, cb) {
      console.log("====================== UPLOAD LOCAL ======================");
      crypto.pseudoRandomBytes(16, function (err, raw) {
        fileName = raw.toString('hex') + Date.now() + '.' + mime.extension(file.mimetype);
        cb(null, fileName);
      });
    }
    })
});

// MW: upload image to S3 bucket
function uploadToS3(req,res,next) {
   fs.readFile(LOCAL_IMAGES_PATH+fileName, function (err, data) {
      if (err) { throw err; }
      var base64data = new Buffer(data, 'binary');
      console.log("====================== UPLOAD TO "+S3_BUCKET_NAME+" ======================");
      s3.putObject({
          Bucket: S3_BUCKET_NAME,
          Key: fileName,
          Body: base64data,
          ACL: 'public-read'
        },
        function (resp) {
          //if(res) console.dir(resp);
          console.log('Successfully uploaded package.');
          if (next) {next();}
        }
      );
   });
}

// MW: save transaction into DB and remove local files
var insertedImageID ='';
var rawUrl='';
function insertImageDB(req,res,next) {
    console.log("====================== DATABASE INSERT ======================");
    sql = 'INSERT INTO images (email, phone, url, bwurl, status, receipt) VALUES ?';
    rawUrl = 'https://' + S3_BUCKET_NAME + '.s3.amazonaws.com/' + fileName;
    var bwurl = '';
    var status = 0; //image not processed yet
    var receipt = fileName.split(".")[0];
    var values = [[req.body.email, req.body.phone, rawUrl , bwurl, status, receipt]];
    dbConnection.query(sql, [values], function (err, result) {
      console.log(sql);
      console.dir(values);
      if (err) throw err;
      console.log("JSON.stringify(result): ");
      insertedImageID = result.insertId.toString();
      next();
    });

    //Clear images folder
    fs.readdir(LOCAL_IMAGES_PATH, (err, files) => {
      if (err) throw error;
      console.log('Removing files:');
      for (const file of files) {
        console.log(file);
        fs.unlink(path.join(LOCAL_IMAGES_PATH, file), err => {
          if (err) throw error;
        });
      }
    });
}

function addToQueue(req, res, next) {
  console.log("====================== ADD TO QUEUE ======================");
  var content = { id: insertedImageID, rawURL: rawUrl, filename: fileName};
  var sqsParams = {
    MessageBody: JSON.stringify(content),
    QueueUrl: SQS_URL
  };

  sqs.sendMessage(sqsParams, function(err, data) {
    if (err) {
      console.log('ERR', err);
    }
    console.log(data);
  });
  if (next) next();
}

////////////////////////
// HTTP-REST handling //
////////////////////////
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(function(req, res, next) {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    next();
});


app.get('/', function(req, res) {
    res.render('index');
});
app.get('/index', function(req, res) {
    res.render('index');
});
app.get('/index.html', function(req, res) {
    res.render('index');
});

app.get('/upload', function(req, res) {
  res.render('upload', {
        submitted: false,
        error: false
      });
});

app.get('/gallery', function(req, res) {
    //Load image data from database
    sql = 'SELECT * FROM images';
    dbConnection.query(sql, function (err, result) {
      console.log(sql);
      if (err) {
        //throw err;
        console.log('Error: ' + err);
        return;
      }
      console.log("Result: ");
      console.dir(result);
      // send result to the frontend
      //console.log(JSON.stringify(result));
      res.render('gallery', {
        images: JSON.parse(JSON.stringify(result))
      });
    });
});


/* 
  POST ACTION 

  Involved middlewares: (main server logic)
  1. upload.single("image") => saves image locally
  2. insertImageDB          => records data in DB and removes files from /images
  3. addToQueue             => sends a task to the queue (SNS)
*/
app.post(API_URL + '/upload', upload.single("image"), uploadToS3, insertImageDB, addToQueue, function(req, res) {
  //Render view, showing a message that the image has been uploaded
  res.render('upload', {
        submitted: true,
        error: false
      });
});

// Route to get all the info from the database
app.get(API_URL + '/getTable', function(req, res) {
  console.log("Received GET");
  sql = 'SELECT * FROM images';
  dbConnection.query(sql, function (err, result) {
    console.log(sql);
    if (err) {
      //throw err;
      console.log('Error: ' + err);
      return;
    }
    console.log("Result: ");
    console.dir(result);
    // send result to the frontend
    res.send(JSON.stringify(result));
  });
});

// Route to remove table 'images'
app.get(API_URL + '/removeTable', function(req, res) {
  console.log("Received GET");
  sql = 'DROP TABLE images';
  dbConnection.query(sql, function (err, result) {
    console.log(sql);
    if (err) {
      //throw err;
      console.log('Error: ' + err);
      return;
    }
    console.log("Result: ");
    console.dir(result);
    // send result to the frontend
    res.send(JSON.stringify(result));
  });
});

var server = app.listen(PORT, function() {
    console.log("Listening on port %s...", server.address().port);
});