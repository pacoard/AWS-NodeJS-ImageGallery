# AWS + NodeJS application: Image processing and storage.

Automated creation and deployment of a NodeJS web application in Amazon Web Services: EC2 for processing, S3 for storage, RDS for database, ELB for load balancing, SNS for notifications, SQS for queueing.

It is a webapp in which you can upload images for processing (transformation to greyscale in this example) and contact information so you get a notification when the job is done.

There is also a dashboard app (the script will tell you the address) in which is possible to monitor parameters like CPU utilization, in/output traffic and number of jobs in the queue and/or database.


## Installation:
0. "aws configure" your AWS account, and make sure you select JSON as output format.
1. Create an IAM role with PowerUserAccess.
2. Create a security group and open port 8000 (used by all of the EC2 and RDS instances).
3. Get your default subnet ID from your availability zone
4. Run the following commands

###### sudo apt install python
###### sudo apt install python-pip
###### sudo pip install requests


## Usage: 
- Creation of the scenario (takes about 10 - 15 minutes)

###### python create-env.py --notify-email <your_email> --key-pair <your_key_pair_name> --security-group sg-XXXXX --subnet-id subnet-XXXXXXX --iam-role <iam_role_with_PowerUserAcces>

- At some point, you will receive an email in the email address you entered. You need to click on the confirm subscription button in order to have the application notify you when the images you upload are processed.
- Once the creation process is finished, the script itself will give you the DNS address of the service (load balancer's address) and the dashboard (another EC2 instance's DNS address, with the port 8000). Copy ad paste them in your web browser.
- In the image upload form, the email field is just an identifier for your image (you can leave it blank if you want), as you have already entered the email you want the notifications sent to. If you do not want an SMS notification, you can leave the phone field blank; otherwise, you would have to type your phone number with the country extension: "+10000000000".

- Destruction of the scenario (takes less than 5 minutes)

###### python destroy-env.py

It may take 5 minutes because the destroy script completely takes care of any leftovers: instances, SNS topics and subscriptions, emptying the S3 buckets, etc. This way, the scenario can be safely restarted by concatenating both commands: "python destroy-env.py && python create-env.py (...arguments...)".

- Large scale test

###### python large-scale-test.py --images-path <path to images folder> 

The path passed as an argument can be absolute or relative to the script. The script will open that folder and upload every single file it contains using HTTP POST messages. Once the script starts, I recommend refreshing the Dashboard website every 10 seconds in order to see how metrics vary and the jobs in the database appear. The SQS dashboard won't ever change because the backend is constantly taking over the SQS and deleting its messages, so they are not visible by others, but if you terminate/stop the backend instance (you will see it has a 'Backend' tag in your AWS console) and upload images, the SQS metrics will show that there are messages

## Web application look:
![Gallery](/images/app-gallery.png)
![Dashboard](/images/app-dashboard.png)

## Comments
- The application is written in NodeJS + Express + EJS.
- The website style has been designed with Bootswatch (abstraction of Bootstrap).
- The creation and destruction scripts are written in Python, although some shell script commands are used within them. It has been done so that the least number of arguments are necessary: for example, the password for the RDS instances is randomly generated in each creation process.
- There is no installation script file, as it is dynamically generated and destroyed in the creation process with the following function:
```python
def createUserData(type): # "backend", "frontend" (autoscaling group) or "dashboard"
	# Set Read-Replica URL for the dashboard app
	t_RDS_HOST = RDS_HOST.replace(RDS_ID, 'read1-'+RDS_ID) if (type == 'dashboard') else RDS_HOST

	fileData = (
		'#!/bin/bash\n'
		'cd /home/ubuntu\n'
		'runuser -l ubuntu -c \'git clone ' + WEBAPP_REPOSITORY + ' webapp\'\n'
		'cd webapp/ITMO-544/mp3/' + type + '\n'
		'cp /home/ubuntu/node_modules -r .\n'
		# PASSING DATA BY REPLACING VALUES IN THE SERVER SOURCE FILES
		"sed -i 's/t_AVAILABILITY_ZONE/\""+ AVAILABILITY_ZONE +"\"/g' server.js\n"
		"sed -i 's/t_SQS_URL/\""+ SQS_URL.replace('/', '\/') +"\"/g' server.js\n"
		"sed -i 's/t_SNS_ARN/\""+ SNS_ARN.replace('/', '\/') +"\"/g' server.js\n"
		"sed -i 's/t_S3_BUCKET_NAME/\""+ S3_BUCKET_NAME +"\"/g' server.js\n"
		"sed -i 's/t_DB_HOST/\""+ t_RDS_HOST +"\"/g' server.js\n"
		"sed -i 's/t_DB_USERNAME/\""+ RDS_MASTER_USERNAME +"\"/g' server.js\n"
		"sed -i 's/t_DB_PASSWORD/\""+ RDS_MASTER_PASSWORD +"\"/g' server.js\n"
		'npm start\n')

	return fileData
```