//var express = require("express");
//var app = express();
//var bodyParser = require("body-parser");
var crypto = require("crypto");
//var mime = require("mime");
var multer = require("multer"); //File upload (local and remote)
var sharp = require("sharp"); //Image processing
var aws = require('aws-sdk'); //AWS interaction
var fs = require('fs');
var path = require('path');
var http = require('http');

//////////////////////
// GLOBAL CONSTANTS //
//////////////////////
var PORT = 8000;
var API_URL = '/api';
var LOCAL_IMAGES_PATH = 'images/';
var s3 = new aws.S3();
//sed -i 's/"t_VALUE"/\"actual_value\"/g' server.js
var sqs = new aws.SQS({region:t_AVAILABILITY_ZONE}); 
var sns1 = new aws.SNS({region:'us-east-1'}); //enable SMS support
var sns2 = new aws.SNS({region:t_AVAILABILITY_ZONE}); // email for your region

var S3_BUCKET_NAME = t_S3_BUCKET_NAME;
var DB_HOST = t_DB_HOST;
var DB_USERNAME = t_DB_USERNAME;
var DB_PASSWORD = t_DB_PASSWORD;
var SQS_URL = t_SQS_URL;
var SNS_ARN = t_SNS_ARN;

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

////////////////////
// Main functions //
////////////////////

var FILE_NAME = '';
var FILE_ID = 0;
function start(url) {
  downloadImage(url);
}
// MW: get raw image from the S3 bucket
function downloadImage(url) {
  console.log("====================== DONWLOAD FROM S3 BUCKET ======================");
  var params = {
    Bucket: S3_BUCKET_NAME,
    Key: FILE_NAME
  };

  var file = fs.createWriteStream(LOCAL_IMAGES_PATH + FILE_NAME);

  // Tell what to do when file has been donwloaded
  file.on('close', function(){
      console.log('File downloaded from S3 bucket');
      processImage();
  });

  s3.getObject(params).createReadStream().on('error', function(err){
      console.log(err);
  }).pipe(file);
}

// MW: transform image to Black&White and upload it to post-S3 bucket
function processImage() {
  console.log("====================== BW TRANSFORMATION ======================");
  console.log("Processing image: " + FILE_NAME);
  // Transfrom to B&W
  //sharp('x.jpeg').greyscale().toFile('bw.jpeg', function(err){});
  sharp(LOCAL_IMAGES_PATH + FILE_NAME)
  .greyscale()
  .toFile(LOCAL_IMAGES_PATH + 'bw_'+FILE_NAME, function(err, info) {
    if (err) {
      console.log('Error: '+err);
      if (info) console.log('Info: '+info);
    } 
    else {
      console.log("Image processed: " + FILE_NAME);
      uploadToS3();
    }
  });
}

//S3 bucket file upload auxiliary function
function uploadToS3() {
  var bucket = 'post-' + S3_BUCKET_NAME;
  console.log("====================== UPLOAD TO "+bucket+" ======================");
  fs.readFile(LOCAL_IMAGES_PATH+'bw_'+FILE_NAME, function (err, data) {
    if (err) { throw err; }
    var base64data = new Buffer(data, 'binary');
    s3.putObject({
        Bucket: bucket,
        Key: 'bw_'+FILE_NAME,
        Body: base64data,
        ACL: 'public-read'
      },
      function (resp) {
        console.log('Successfully uploaded package.');
        insertImageDB();
      }
    );
  });
}

// MW: save transaction into DB and remove local files
function insertImageDB() {
    console.log("====================== DATABASE INSERT ======================");
    
    var bwurl = 'https://post-' + S3_BUCKET_NAME + '.s3.amazonaws.com/' + 'bw_' + FILE_NAME;
    sql = "UPDATE images \
            SET bwurl = '" + bwurl + "',\
                status = 1,\
                receipt = 'bw_" + FILE_NAME.split(".")[0] + "'\
            WHERE id =" + FILE_ID.toString();
    
    dbConnection.query(sql, function (err, result) {
      console.log(sql);
      if (err) throw err;
      console.log("Result: ");
      console.log(result);
      sendNotification();
    });
    // Clear images folder
    fs.readdir(LOCAL_IMAGES_PATH, (err, files) => {
      if (err) throw error;
      for (const file of files) {
        fs.unlink(path.join(LOCAL_IMAGES_PATH, file), err => {
          if (err) throw error;
        });
      }
    });
}

// Send notification to phone number and subscribed email
function sendNotification() {
  console.log("====================== SNS NOTIFICATION ======================");
  sql = 'SELECT * FROM images WHERE id=' + FILE_ID.toString();
  dbConnection.query(sql, function (err, result) {
    console.log(sql);
    if (err) {
      //throw err;
      console.log('Error: ' + err);
      return;
    }
    var imageRow = result[0];

    // Send to SMS to phone number
    var pubParams = {
      Message: JSON.stringify(imageRow), 
      PhoneNumber: imageRow.phone,
      Subject: 'MP2 - Image processed',
    // TopicArn: SNS_ARN
    };

    sns1.publish(pubParams, function(err, data) {
      console.log("SNS publish callback: ");
      if (err) { // The entered phone number is not valid
        console.log(err);
        pubParams.Message = 'The phone number you entered was not valid and the SMS notification was not sent.\n\n'  + JSON.stringify(imageRow)
      }
      if(data) console.log(data);

      // Then send notification to email as well
      /*var pubParams2 = {
        Message: JSON.stringify(imageRow), 
      //  PhoneNumber: imageRow.phone,
        Subject: 'MP2 - Image processed',
        TopicArn: SNS_ARN
      };*/
      delete pubParams.PhoneNumber;
      pubParams.TopicArn = SNS_ARN
      
      sns2.publish(pubParams, function(err, data) {
        console.log("SNS publish callback: ");
        if (err) console.log(err);
        if(data) console.log(data);
      });
    });
  });
}


/////////////////////////////////////////////
// Poll SQS for messages and dispatch them //
/////////////////////////////////////////////
setInterval(function() {
  sqs.receiveMessage(
    {
      QueueUrl: SQS_URL,
      MaxNumberOfMessages: 1, // how many messages do we wanna retrieve?
      VisibilityTimeout: 10, // seconds - how long we want a lock on this job
      WaitTimeSeconds: 5 // seconds - how long should we wait for a message?
    }, 
    function(err, data) {
      // If there are any messages to get
      if (data.Messages) {
        // Get the first message (should be the only one since we said to only get one above)
        var rawMessage = data.Messages[0]
        var msg = JSON.parse(rawMessage.Body);
        
        // Dispatch message

        console.log("Received: ")
        console.log(msg);

        FILE_NAME = msg.filename;
        FILE_ID = msg.id;

        // Start flow of the program
        start(msg.url);

        // Delete message in queue so it is not dispatched again
        sqs.deleteMessage(
          {
            QueueUrl: SQS_URL,
            ReceiptHandle: rawMessage.ReceiptHandle
          }, 
          function(err, data) {
            console.log(err);
          }
        );
      } 
   }
  );
}, 5000); //poll for 5 seconds every 5 seconds