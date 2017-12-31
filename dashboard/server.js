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
const EC2_METRICS_LIST = ["CPUUtilization","DiskReadBytes","DiskWriteBytes","DiskReadOps","DiskWriteOps","NetworkIn","NetworkOut"];
//Seconds | Microseconds | Milliseconds | Bytes | Kilobytes | Megabytes | Gigabytes | Terabytes | Bits | Kilobits | Megabits | Gigabits | Terabits | Percent | Count | Bytes/Second | Kilobytes/Second | Megabytes/Second | Gigabytes/Second | Terabytes/Second | Bits/Second | Kilobits/Second | Megabits/Second | Gigabits/Second | Terabits/Second | Count/Second | None
const UNITS_LIST = ["Percent","Bytes","Bytes","Count","Count","Bytes","Bytes"];
//const SQS_METRICS_LIST = ["NumberOfMessagesReceived", "NumberOfMessagesSent", "ApproximateNumberOfMessagesVisible", "ApproximateNumberOfMessagesNotVisible", "NumberOfMessagesDeleted"]
const SQS_METRICS_LIST = ["NumberOfMessagesSent", "ApproximateNumberOfMessagesVisible"];
/*NumberOfMessagesSent/NumberOfMessagesReceived
ApproximateNumberOfMessagesNotVisible/NumberOfMessagesDeleted (jobs invisible)
ApproximateNumberOfMessagesVisible (jobs visible)*/
var PORT = 8000;
//sed -i 's/"t_VALUE"/\"actual_value\"/g' server.js*
var cloudwatch = new aws.CloudWatch({apiVersion: '2010-08-01', region:t_AVAILABILITY_ZONE});
var sqs = new aws.SQS({region:t_AVAILABILITY_ZONE}); 
var ec2 = new aws.EC2({region:t_AVAILABILITY_ZONE});
var meta  = new aws.MetadataService();
var DB_HOST = t_DB_HOST;
var DB_USERNAME = t_DB_USERNAME;
var DB_PASSWORD = t_DB_PASSWORD;
var SQS_URL = t_SQS_URL;
var DB_PORT = '8000';
var DB_NAME = 'imagesdb'; 
var BACKEND_INSTANCE_ID = '';
var DASHBOARD_INSTANCE_ID = '';

// Get Dashboard instance id
meta.request("/latest/meta-data/instance-id", function(err, data){
	console.log("====================== GET OWN (DASHBOARD) INSTANCE ID ======================");
	console.log(data);
	DASHBOARD_INSTANCE_ID = data;
});

// Get backend instance id
ec2.describeInstances({Filters: [{Name: 'tag:Name',Values: ['Backend']}]}, function(err, data) {
	console.log("====================== GET BACKEND INSTANCE ID ======================");
	if (err) console.log(err, err.stack); // an error occurred
	else { // successful response
		console.log(data['Reservations'][0]['Instances'][0]['InstanceId']);
		BACKEND_INSTANCE_ID = data['Reservations'][0]['Instances'][0]['InstanceId'];
	}
});


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

function getDateInterval(minutes) {
	var date = new Date();
	return {
		StartTime: new Date(date.getTime() - minutes*60000),
		EndTime: date
	}
}
function generateParams(namespace, item, stat, metric, units, interval) {
	var date = new Date();
	return {
		//EndTime: new Date || 'Wed Nov 22 2017 17:30:00 GMT-0800 (PST)' || 123456789, // required
		EndTime: interval.EndTime, // required
		MetricName: metric, // required
		Namespace: 'AWS/'+namespace.toUpperCase(), // required
		Period: 60, // required
		//StartTime: new Date || 'Wed Dec 31 1969 16:00:00 GMT-0800 (PST)' || 123456789, // required
		StartTime: interval.StartTime, // X minute => ? datapoint
		Dimensions: [item]
		// Fronted
			/*{
				Name: 'AutoScalingGroupName', // required
				Value: 'itmo544-autoscaling-group' // required
			},
		// Backend
			{
				Name: 'InstanceId', // required
				// Value: t_BACKEND_INSTANCE_ID
				Value: 'i-04a48eeab26b72f91' // required
			}
		// Dashboard
			{
				Name: 'InstanceId', // required
				Value: t_DASHBOARD_INSTANCE_ID // required
			},*/
			// more items
		,
		Statistics: [
			//"SampleCount", "Average", "Sum", "Minimum", "Maximum",
			stat
			// more items
		],
		Unit: units//Seconds | Microseconds | Milliseconds | Bytes | Kilobytes | Megabytes | Gigabytes | Terabytes | Bits | Kilobits | Megabits | Gigabits | Terabits | Percent | Count | Bytes/Second | Kilobytes/Second | Megabytes/Second | Gigabytes/Second | Terabytes/Second | Bits/Second | Kilobits/Second | Megabits/Second | Gigabits/Second | Terabits/Second | Count/Second | None
	};
}

// MIDDLEWARES

function getJobsData(req, res, next) {
	console.log("====================== GET JOBS DATA ======================");
	sql = 'SELECT id, status FROM images';
	dbConnection.query(sql, function (err, result) {
		console.log(sql);
		if (err) {
			//throw err;
			console.log('Error: ' + err);
			return;
		}
		res.locals.jobs = result
		console.log('res.locals.jobs');
		console.log(res.locals.jobs);
		next();
	});
}

function getSQSData(req, res, next) {
	console.log("====================== GET SQS DATA ======================");
	var promises = [];
	res.locals.sqs = [];
	for (var i = 0; i < SQS_METRICS_LIST.length; i++) {
		var params = generateParams(
			'SQS',
			{Name:'QueueName',Value:'itmo544-queue'},
			'Sum',
			SQS_METRICS_LIST[i], 
			'Count',
			getDateInterval(5)
		);
		promises.push(cloudwatch.getMetricStatistics(params).promise());
	}
	Promise.all(promises).then(function(values) {
		values.forEach(function(value) {
		    res.locals.sqs.push({
		    	metric: value['Label'],
		    	value: value['Datapoints'][0]['Sum']
		    })
		});
		console.log('res.locals.sqs');
		console.log(res.locals.sqs);
		next();
	}).catch(function(err) {console.log(err);});
}

function getEC2Data(req,res,next) {
	console.log("====================== GET EC2 DATA ======================");
	function getPromisesForInstances(instance) {
		var promises = [];
		for (var i = 0; i < EC2_METRICS_LIST.length; i++) {
			var params = generateParams(
				'EC2',
				instance,
				"Average",
				EC2_METRICS_LIST[i], 
				UNITS_LIST[i],
				getDateInterval(10)
				);
			promises.push(cloudwatch.getMetricStatistics(params).promise());
		}
		return promises;
	}
	
	res.locals.frontend = [];
	res.locals.backend = [];
	res.locals.dashboard = [];
	var promisesFrontend = getPromisesForInstances(
		{Name:'AutoScalingGroupName',Value:'itmo544-autoscaling-group'}
	);
	var promisesBackend = getPromisesForInstances(
		{Name:'InstanceId',Value:BACKEND_INSTANCE_ID}
	);
	var promisesDashboard = getPromisesForInstances(
		{Name:'InstanceId',Value:DASHBOARD_INSTANCE_ID}
	);
	promises = promisesFrontend.concat(promisesBackend, promisesDashboard);

	Promise.all(promises).then(function(values) {
		var i = 0;
		values.forEach(function(value) {
			i++;
			var datapoints = [];
			value['Datapoints'].forEach(function(point) {
				datapoints.push(point['Average']);
			});
			var parsedValues = '('+UNITS_LIST[(i-1)%7]+') ' + datapoints.join(', ');
			if (i < 8) {
				res.locals.frontend.push({
			    	metric: value['Label'],
			    	values: parsedValues
			    });
			} else if (i > 14) {
				res.locals.dashboard.push({
			    	metric: value['Label'],
			    	values: parsedValues
			    });
			} else  { // i is in [7,14]
				res.locals.backend.push({
			    	metric: value['Label'],
			    	values: parsedValues
			    });
			}

		});

		console.log('res.locals.frontend');
		console.log(res.locals.frontend);
		console.log('res.locals.backend');
		console.log(res.locals.backend);
		console.log('res.locals.dashboard');
		console.log(res.locals.dashboard);
		next();
	}).catch(function(err) {console.log(err);});
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


app.get('/', getJobsData, getSQSData, getEC2Data, function(req, res) {
	//TODO para ir sacando datos con cada middleware, ir guardandolos en req.locals.(...)
	//TODO MW's: req.locals.sqs = datos SQS => req.locals.jobs = datos jobs =>  req.locals.ec2 = datos EC2 => res.render con req.locals
	//https://stackoverflow.com/questions/18875292/passing-variables-to-the-next-middleware-using-next-in-expressjs
	console.log('====================== LAST MIDDLEWARE ======================');

	console.log('res.locals');
	console.log(res.locals);

	// send result to the frontend
	res.render('index', {
		jobs: res.locals.jobs,
		queue: res.locals.sqs,
		frontend: res.locals.frontend,
		backend: res.locals.backend,
		dashboard: res.locals.dashboard
	});
});


// Test API urls
app.get('/SQSmetrics', function(req, res) {
	var promises = [];
	for (var i = 0; i < SQS_METRICS_LIST.length; i++) {
		console.log(i);
		var params = generateParams(
			'SQS',
			{Name:'QueueName',Value:'itmo544-queue'},
			 //{Name: 'InstanceId', Value: BACKEND_INSTANCE_ID}
				//{Name: 'InstanceId', Value: DASHBOARD_INSTANCE_ID}
			'Sum',
			SQS_METRICS_LIST[i], 
			'Count',
			getDateInterval(5)
			);
		//if (METRICS_LIST[i] == 'i-04a48eeab26b72f91') params.StartTime
		/*cloudwatch.getMetricStatistics(params, function(err, data) {
			console.log('Metric: ================');
			if (err) console.log(err, err.stack); // an error occurred
			else {
				console.log(JSON.stringify(data));            // successful response
			}
		});*/
		/*try {
			console.log('Metric: ================');
			var data = cloudwatch.getMetricStatistics(params);
			console.log(data.response);
		} catch(err) {console.log(err);}*/
		promises.push(cloudwatch.getMetricStatistics(params).promise());
	}
	Promise.all(promises).then(function(values) {
		console.log(values);
	}).catch(function(err) {console.log(err);});
	res.send('SQSmetrics');
});

app.get('/ec2metrics', function(req, res) {
	for (var i = 0; i < EC2_METRICS_LIST.length; i++) {
		var params = generateParams(
			'EC2',
			{Name:'AutoScalingGroupName',Value:'itmo544-autoscaling-group'},
			 //{Name: 'InstanceId', Value: BACKEND_INSTANCE_ID}
				//{Name: 'InstanceId', Value: DASHBOARD_INSTANCE_ID}
			"Average",
			EC2_METRICS_LIST[i], 
			UNITS_LIST[i],
			getDateInterval(1)
			);
		//if (METRICS_LIST[i] == 'i-04a48eeab26b72f91') params.StartTime
		cloudwatch.getMetricStatistics(params, function(err, data) {
			console.log('Metric: ================');
			if (err) console.log(err, err.stack); // an error occurred
			else {
				console.log(JSON.stringify(data));            // successful response
			}
		});
	}
	res.send('ec2metrics');
});

var server = app.listen(PORT, function() {
		console.log("Listening on port %s...", server.address().port);
});